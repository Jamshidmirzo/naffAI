from decimal import Decimal

import pytest
from django.utils import timezone

from apps.audit.models import AuditLog
from apps.catalog.models import Channel
from apps.operators.models import Operator
from apps.operators.services import operator_delete
from apps.payroll.models import PayrollRule
from apps.sales.models import Sale, SaleOperator, SalePartner
from apps.sales.services import sale_create


@pytest.fixture
def operator(db):
    return Operator.objects.create(full_name="Мадина Иванова", status="active")


@pytest.fixture
def other_operator(db):
    return Operator.objects.create(full_name="Азиз Азизов", status="active")


@pytest.fixture
def channel(db):
    return Channel.objects.create(name="Telegram")


@pytest.mark.django_db
def test_operator_delete_without_sales(operator):
    operator_id = operator.id
    result = operator_delete(operator=operator, user=None)
    assert not Operator.objects.filter(pk=operator_id).exists()
    assert result["sales_soft_deleted_count"] == 0
    assert result["sales_shrunk_count"] == 0
    assert result["sales_annotated_count"] == 0  # back-compat alias


@pytest.mark.django_db
def test_delete_operator_with_single_op_sale_soft_deletes_sale(operator, channel):
    """
    Оператор был единственным продавцом на sale → sale уходит в is_deleted.
    Общая сумма продаж в Dashboard уменьшается на её вклад.
    """
    sale = sale_create(
        imei="490154203237518",
        phone_model="iPhone 13",
        operator_id=operator.id,
        channel_id=channel.id,
        amount=Decimal("3500000"),
    )
    op_id = operator.id
    result = operator_delete(operator=operator, user=None)

    assert not Operator.objects.filter(pk=op_id).exists()
    sale.refresh_from_db()
    assert sale.is_deleted is True
    assert sale.deleted_at is not None
    assert result["sales_soft_deleted_count"] == 1
    assert sale.id in result["sales_soft_deleted_ids"]
    assert result["sales_shrunk_count"] == 0


@pytest.mark.django_db
def test_delete_operator_with_multi_op_sale_shrinks_amount_by_share(
    operator, other_operator, channel
):
    """
    Оператор был одним из двух → sale остаётся, sale.amount уменьшается
    ровно на его долю, его SaleOperator-строка удаляется, второй
    оператор сохраняет свою долю. SalePartner пропорционально уменьшен,
    так что Σ partner.amount == new sale.amount. В sale.comment
    появляется пометка о списанной доле.
    """
    sale = sale_create(
        imei="490154203237518",
        phone_model="iPhone 17 Pro Max",
        operators=[
            {"operator_id": operator.id, "amount": "3000000"},
            {"operator_id": other_operator.id, "amount": "2000000"},
        ],
        partners=[{"partner_id": channel.id, "amount": "5000000"}],
    )
    op_id = operator.id
    result = operator_delete(operator=operator, user=None)

    assert not Operator.objects.filter(pk=op_id).exists()
    sale.refresh_from_db()
    assert sale.is_deleted is False
    # Amount shrunk by the leaving operator's share (5M − 3M = 2M).
    assert sale.amount == Decimal("2000000.00")
    assert sale.discount == Decimal("0.00")
    # Only the other operator's line remains.
    remaining_lines = list(
        SaleOperator.objects.filter(sale=sale).values_list("operator_id", "amount")
    )
    assert remaining_lines == [(other_operator.id, Decimal("2000000.00"))]
    # Partner line shrunk to match new sale.amount.
    remaining_partners = list(
        SalePartner.objects.filter(sale=sale).values_list("partner_id", "amount")
    )
    assert remaining_partners == [(channel.id, Decimal("2000000.00"))]
    # Invariant: Σ SaleOperator.amount == amount − discount.
    op_sum = sum(
        Decimal(x) for x in SaleOperator.objects.filter(sale=sale).values_list("amount", flat=True)
    )
    assert op_sum == sale.amount - sale.discount
    # Comment carries the deletion note.
    assert "Мадина Иванова" in sale.comment
    assert "3 000 000" in sale.comment  # subtracted share
    assert "2 000 000" in sale.comment  # new sale amount
    assert result["sales_soft_deleted_count"] == 0
    assert result["sales_shrunk_count"] == 1
    assert sale.id in result["sales_shrunk_ids"]


@pytest.mark.django_db
def test_delete_operator_with_multi_op_sale_and_discount(
    operator, other_operator, channel
):
    """
    С discount на входе: gross=6M, discount=1M, net=5M. sale_create
    сам пропорционально уменьшает operator amounts (3.6M→3M, 2.4M→2M net).
    После удаления оператора A (net-доля 3M):
      share_gross = 3M × 6/5 = 3.6M, share_disc = 0.6M
      new_amount = 2.4M, new_discount = 0.4M
      Инвариант: 2.4M − 0.4M = 2M = доля B.
    """
    sale = sale_create(
        imei="490154203237518",
        phone_model="iPhone 17",
        operators=[
            # gross values — sale_create scales them down by (1 − discount/gross).
            {"operator_id": operator.id, "amount": "3600000"},
            {"operator_id": other_operator.id, "amount": "2400000"},
        ],
        partners=[{"partner_id": channel.id, "amount": "6000000"}],
        discount="1000000",
    )
    # Sanity: sale_create produced the expected net shares.
    assert sale.amount == Decimal("6000000.00")
    assert sale.discount == Decimal("1000000.00")
    net_shares_before = dict(
        SaleOperator.objects.filter(sale=sale).values_list("operator_id", "amount")
    )
    assert net_shares_before[operator.id] == Decimal("3000000.00")
    assert net_shares_before[other_operator.id] == Decimal("2000000.00")

    operator_delete(operator=operator, user=None)

    sale.refresh_from_db()
    assert sale.amount == Decimal("2400000.00")
    assert sale.discount == Decimal("400000.00")
    # Only other operator remains with untouched net share.
    remaining_lines = list(
        SaleOperator.objects.filter(sale=sale).values_list("operator_id", "amount")
    )
    assert remaining_lines == [(other_operator.id, Decimal("2000000.00"))]
    # Partner line shrunk to new gross.
    remaining_partners = list(
        SalePartner.objects.filter(sale=sale).values_list("partner_id", "amount")
    )
    assert remaining_partners == [(channel.id, Decimal("2400000.00"))]
    # Both invariants intact.
    op_sum = sum(
        Decimal(x) for x in SaleOperator.objects.filter(sale=sale).values_list("amount", flat=True)
    )
    partner_sum = sum(
        Decimal(x) for x in SalePartner.objects.filter(sale=sale).values_list("amount", flat=True)
    )
    assert op_sum == sale.amount - sale.discount
    assert partner_sum == sale.amount


@pytest.mark.django_db
def test_delete_operator_soft_deleted_sales_are_ignored(operator, channel):
    """
    Already-soft-deleted sales don't count as either single-op or multi-op —
    they're historical, we leave them alone. The active sales_unlinked
    count reflects the FK detach (legacy Sale.operator=NULL for the
    soft-deleted row too).
    """
    sale = sale_create(
        imei="490154203237518",
        phone_model="iPhone 13",
        operator_id=operator.id,
        channel_id=channel.id,
        amount=Decimal("3500000"),
    )
    sale.is_deleted = True
    sale.deleted_at = timezone.now()
    sale.save(update_fields=["is_deleted", "deleted_at"])

    op_id = operator.id
    result = operator_delete(operator=operator, user=None)

    assert not Operator.objects.filter(pk=op_id).exists()
    # Neither newly-soft-deleted nor shrunk.
    assert result["sales_soft_deleted_count"] == 0
    assert result["sales_shrunk_count"] == 0
    # But the FK-detach still touched it.
    sale.refresh_from_db()
    assert sale.operator_id is None


@pytest.mark.django_db
def test_delete_operator_bulk_audit(operator, other_operator, channel):
    """
    One audit entry summarises everything: snapshot + all counts, including
    the new sales_soft_deleted / sales_annotated pair.
    """
    PayrollRule.objects.create(
        scope="operator",
        operator=operator,
        threshold=Decimal("50000000"),
        payout_type="percent",
        payout_value=Decimal("3.0"),
    )
    # One single-op sale → soft-deleted.
    sale_create(
        imei="490154203237518",
        phone_model="iPhone 13",
        operator_id=operator.id,
        channel_id=channel.id,
        amount=Decimal("3500000"),
    )
    # One multi-op sale → annotated.
    sale_create(
        imei="356938035643809",
        phone_model="iPhone 15",
        operators=[
            {"operator_id": operator.id, "amount": "3000000"},
            {"operator_id": other_operator.id, "amount": "2000000"},
        ],
        partners=[{"partner_id": channel.id, "amount": "5000000"}],
    )

    op_id = operator.id
    operator_delete(operator=operator, user=None)

    entry = AuditLog.objects.get(
        entity="operators.Operator",
        entity_id=str(op_id),
        action="delete",
    )
    changes = entry.changes
    assert changes["snapshot"]["full_name"] == "Мадина Иванова"
    counts = changes["deleted_related"]
    assert counts["payroll_rules_deleted"] == 1
    assert counts["sales_soft_deleted_count"] == 1
    assert counts["sales_shrunk_count"] == 1
    assert "sales_soft_deleted_ids" in counts
    assert "sales_shrunk_ids" in counts
    assert "sales_shrunk_details" in counts
    assert "sale_operator_rows_deleted" in counts
    assert "sales_unlinked" in counts
    assert "profiles_unlinked" in counts

    # Sales themselves: 1 soft-deleted, 1 still active but shrunk by
    # the leaving operator's share (5M − 3M = 2M).
    active = Sale.objects.filter(is_deleted=False).count()
    soft = Sale.objects.filter(is_deleted=True).count()
    assert (active, soft) == (1, 1)
    remaining = Sale.objects.filter(is_deleted=False).first()
    assert remaining.amount == Decimal("2000000.00")

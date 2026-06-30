"""
Tests for the per-sale discount feature.

The contract we verify:
  1. Discount on `sale_create` proportionally reduces every operator-line
     amount; partner-line amounts stay untouched.
  2. Σ SaleOperator.amount == Sale.amount − Sale.discount (exact, no
     sub-cent drift).
  3. Patching the discount on an existing sale reallocates operator
     lines while preserving each operator's relative share of the gross.
  4. Invalid discounts (negative, >= amount) raise ApplicationError.
  5. Two audit entries are written when a discount-only patch lands on a
     sale that also has scalar field changes; one of them is tagged
     with the «Скидка» marker.
"""

from decimal import Decimal

import pytest

from apps.audit.models import AuditLog
from apps.catalog.models import Channel
from apps.common.exceptions import ApplicationError
from apps.operators.models import Operator
from apps.sales.services import sale_create, sale_partial_update


@pytest.fixture
def operator_a(db):
    return Operator.objects.create(full_name="Анвар", status="active")


@pytest.fixture
def operator_b(db):
    return Operator.objects.create(full_name="Бахром", status="active")


@pytest.fixture
def partner(db):
    return Channel.objects.create(name="Alif")


@pytest.mark.django_db
def test_sale_create_with_zero_discount_keeps_operator_amount_intact(
    operator_a, partner
):
    sale = sale_create(
        imei="490154203237518",
        phone_model="iPhone 13",
        operators=[{"operator_id": operator_a.id, "amount": "5000000"}],
        partners=[{"partner_id": partner.id, "amount": "5000000"}],
        discount=Decimal("0"),
    )
    assert sale.discount == Decimal("0")
    line = sale.operator_lines.get()
    assert line.amount == Decimal("5000000.00")


@pytest.mark.django_db
def test_sale_create_single_operator_discount_reduces_credit(operator_a, partner):
    sale = sale_create(
        imei="490154203237518",
        phone_model="iPhone 13",
        operators=[{"operator_id": operator_a.id, "amount": "5000000"}],
        partners=[{"partner_id": partner.id, "amount": "5000000"}],
        discount=Decimal("500000"),
    )
    assert sale.amount == Decimal("5000000")
    assert sale.discount == Decimal("500000")
    line = sale.operator_lines.get()
    assert line.amount == Decimal("4500000.00")


@pytest.mark.django_db
def test_sale_create_split_operators_discount_is_proportional(
    operator_a, operator_b, partner
):
    # 70/30 split, 1M discount on a 10M sale → 9M net split 6.3M / 2.7M
    sale = sale_create(
        imei="490154203237518",
        phone_model="iPhone 13",
        operators=[
            {"operator_id": operator_a.id, "amount": "7000000"},
            {"operator_id": operator_b.id, "amount": "3000000"},
        ],
        partners=[{"partner_id": partner.id, "amount": "10000000"}],
        discount=Decimal("1000000"),
    )
    lines = list(sale.operator_lines.order_by("id"))
    assert lines[0].amount == Decimal("6300000.00")
    assert lines[1].amount == Decimal("2700000.00")
    # Exact sum: no sub-cent drift.
    assert sum(line.amount for line in lines) == sale.amount - sale.discount


@pytest.mark.django_db
def test_discount_split_remainder_lands_on_last_line(operator_a, operator_b, partner):
    # Pick numbers where the natural ratio doesn't land on a clean cent.
    # 333 / 667 = 1000, discount 100 → net 900; raw shares 299.7 / 600.3
    # → quantized 299.70 / 600.30 sums exactly. We use a trickier ratio:
    # 333 / 668 = 1001, discount 7 → net 994; 333/1001 * 994 = 330.6713...
    # round half-up → 330.67; remainder absorbed by last line.
    sale = sale_create(
        imei="490154203237518",
        phone_model="iPhone 13",
        operators=[
            {"operator_id": operator_a.id, "amount": "333"},
            {"operator_id": operator_b.id, "amount": "668"},
        ],
        partners=[{"partner_id": partner.id, "amount": "1001"}],
        discount=Decimal("7"),
    )
    lines = list(sale.operator_lines.order_by("id"))
    # Sum is exactly net — that is the invariant the test cares about.
    assert sum(line.amount for line in lines) == Decimal("994.00")
    # First line was rounded; last line absorbs the remainder.
    assert lines[0].amount == Decimal("330.67")
    assert lines[1].amount == Decimal("663.33")


@pytest.mark.django_db
def test_sale_create_partner_lines_unchanged_by_discount(operator_a, partner):
    """Partner-line amounts represent actual money flow through the
    payment method — the discount must not touch them."""
    sale = sale_create(
        imei="490154203237518",
        phone_model="iPhone 13",
        operators=[{"operator_id": operator_a.id, "amount": "5000000"}],
        partners=[{"partner_id": partner.id, "amount": "5000000"}],
        discount=Decimal("500000"),
    )
    partner_line = sale.partner_lines.get()
    assert partner_line.amount == Decimal("5000000.00")
    assert sale.amount == Decimal("5000000.00")


@pytest.mark.django_db
def test_sale_create_negative_discount_raises(operator_a, partner):
    with pytest.raises(ApplicationError, match="Скидка не может быть отрицательной"):
        sale_create(
            imei="490154203237518",
            phone_model="iPhone 13",
            operators=[{"operator_id": operator_a.id, "amount": "5000000"}],
            partners=[{"partner_id": partner.id, "amount": "5000000"}],
            discount=Decimal("-100"),
        )


@pytest.mark.django_db
def test_sale_create_discount_ge_amount_raises(operator_a, partner):
    with pytest.raises(ApplicationError, match="не может быть равна или превышать"):
        sale_create(
            imei="490154203237518",
            phone_model="iPhone 13",
            operators=[{"operator_id": operator_a.id, "amount": "5000000"}],
            partners=[{"partner_id": partner.id, "amount": "5000000"}],
            discount=Decimal("5000000"),
        )


@pytest.mark.django_db
def test_partial_update_discount_reallocates_operator_lines(
    operator_a, operator_b, partner
):
    sale = sale_create(
        imei="490154203237518",
        phone_model="iPhone 13",
        operators=[
            {"operator_id": operator_a.id, "amount": "7000000"},
            {"operator_id": operator_b.id, "amount": "3000000"},
        ],
        partners=[{"partner_id": partner.id, "amount": "10000000"}],
        discount=Decimal("0"),
    )

    # Apply a 2M discount via partial update.
    sale_partial_update(sale=sale, fields={"discount": Decimal("2000000")})
    sale.refresh_from_db()
    assert sale.discount == Decimal("2000000")

    lines = list(sale.operator_lines.order_by("id"))
    # 7M / 10M × 8M net = 5.6M; 3M / 10M × 8M = 2.4M
    assert lines[0].amount == Decimal("5600000.00")
    assert lines[1].amount == Decimal("2400000.00")
    assert sum(line.amount for line in lines) == sale.amount - sale.discount


@pytest.mark.django_db
def test_partial_update_discount_can_be_reduced_back(operator_a, operator_b, partner):
    """A second discount edit must reverse the first proportionally
    rather than compound on the already-reduced lines."""
    sale = sale_create(
        imei="490154203237518",
        phone_model="iPhone 13",
        operators=[
            {"operator_id": operator_a.id, "amount": "7000000"},
            {"operator_id": operator_b.id, "amount": "3000000"},
        ],
        partners=[{"partner_id": partner.id, "amount": "10000000"}],
        discount=Decimal("2000000"),
    )
    # Now drop the discount to 500k.
    sale_partial_update(sale=sale, fields={"discount": Decimal("500000")})
    sale.refresh_from_db()
    lines = list(sale.operator_lines.order_by("id"))
    # 7M / 10M × 9.5M = 6.65M; 3M / 10M × 9.5M = 2.85M
    assert lines[0].amount == Decimal("6650000.00")
    assert lines[1].amount == Decimal("2850000.00")
    assert sum(line.amount for line in lines) == Decimal("9500000.00")


@pytest.mark.django_db
def test_partial_update_discount_to_zero_restores_full_credit(
    operator_a, operator_b, partner
):
    sale = sale_create(
        imei="490154203237518",
        phone_model="iPhone 13",
        operators=[
            {"operator_id": operator_a.id, "amount": "7000000"},
            {"operator_id": operator_b.id, "amount": "3000000"},
        ],
        partners=[{"partner_id": partner.id, "amount": "10000000"}],
        discount=Decimal("2000000"),
    )
    sale_partial_update(sale=sale, fields={"discount": Decimal("0")})
    sale.refresh_from_db()
    lines = list(sale.operator_lines.order_by("id"))
    assert lines[0].amount == Decimal("7000000.00")
    assert lines[1].amount == Decimal("3000000.00")
    assert sale.discount == Decimal("0")


@pytest.mark.django_db
def test_partial_update_discount_writes_dedicated_audit_entry(operator_a, partner):
    sale = sale_create(
        imei="490154203237518",
        phone_model="iPhone 13",
        operators=[{"operator_id": operator_a.id, "amount": "5000000"}],
        partners=[{"partner_id": partner.id, "amount": "5000000"}],
        discount=Decimal("0"),
    )
    AuditLog.objects.filter(entity_id=sale.id).delete()  # clean slate

    sale_partial_update(
        sale=sale,
        fields={"discount": Decimal("500000"), "comment": "Промо"},
    )

    entries = list(AuditLog.objects.filter(entity_id=sale.id).order_by("id"))
    assert len(entries) == 2
    # First entry: scalar diff (comment)
    assert "comment" in entries[0].changes
    # Second entry: discount change, marked with the «Скидка» tag.
    assert entries[1].comment == "Скидка"
    assert "discount" in entries[1].changes
    assert entries[1].changes["discount"]["new"] == "500000"


@pytest.mark.django_db
def test_partial_update_invalid_discount_raises(operator_a, partner):
    sale = sale_create(
        imei="490154203237518",
        phone_model="iPhone 13",
        operators=[{"operator_id": operator_a.id, "amount": "5000000"}],
        partners=[{"partner_id": partner.id, "amount": "5000000"}],
        discount=Decimal("0"),
    )
    with pytest.raises(ApplicationError):
        sale_partial_update(sale=sale, fields={"discount": Decimal("-100")})
    with pytest.raises(ApplicationError):
        sale_partial_update(sale=sale, fields={"discount": Decimal("5000000")})


@pytest.mark.django_db
def test_total_price_annotation_returns_net(operator_a, partner):
    """`sale_queryset_with_totals` annotates `total_price = amount − discount`."""
    from apps.sales.selectors import sale_queryset_with_totals

    sale = sale_create(
        imei="490154203237518",
        phone_model="iPhone 13",
        operators=[{"operator_id": operator_a.id, "amount": "5000000"}],
        partners=[{"partner_id": partner.id, "amount": "5000000"}],
        discount=Decimal("750000"),
    )
    fetched = sale_queryset_with_totals().get(pk=sale.pk)
    assert fetched.total_price == Decimal("4250000.00")


@pytest.mark.django_db
def test_kpi_snapshot_returns_net_revenue(operator_a, partner):
    """Dashboard KPIs sum amount − discount, not amount alone."""
    from apps.analytics.selectors import kpi_snapshot

    sale_create(
        imei="490154203237518",
        phone_model="iPhone 13",
        operators=[{"operator_id": operator_a.id, "amount": "5000000"}],
        partners=[{"partner_id": partner.id, "amount": "5000000"}],
        discount=Decimal("750000"),
    )
    snap = kpi_snapshot()
    # The single sale lives in today/week/month buckets.
    assert Decimal(snap["today"]["total"]) == Decimal("4250000.00")
    assert Decimal(snap["month"]["total"]) == Decimal("4250000.00")

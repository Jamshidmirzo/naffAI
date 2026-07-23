from decimal import Decimal

import pytest
from django.utils import timezone
from rest_framework.exceptions import ValidationError

from apps.audit.models import AuditLog
from apps.catalog.models import Channel
from apps.operators.models import Operator
from apps.operators.services import operator_delete
from apps.payroll.models import PayrollRule
from apps.sales.services import sale_create


@pytest.fixture
def operator(db):
    return Operator.objects.create(full_name="Удаляемый Оператор", status="active")


@pytest.fixture
def channel(db):
    return Channel.objects.create(name="Telegram")


@pytest.mark.django_db
def test_operator_delete_without_sales(operator):
    operator_id = operator.id
    operator_delete(operator=operator, user=None)
    assert not Operator.objects.filter(pk=operator_id).exists()


@pytest.mark.django_db
def test_operator_delete_with_sales_is_refused(operator, channel):
    sale_create(
        imei="490154203237518",
        phone_model="iPhone 13",
        operator_id=operator.id,
        channel_id=channel.id,
        amount=Decimal("3500000"),
    )
    with pytest.raises(ValidationError) as exc:
        operator_delete(operator=operator, user=None)
    msg = str(exc.value)
    assert "Удаление невозможно" in msg
    assert "деактивацию" in msg
    # Operator must still be there.
    assert Operator.objects.filter(pk=operator.id).exists()


@pytest.mark.django_db
def test_operator_delete_refused_with_active_sales_but_ok_with_soft_deleted(
    operator, channel
):
    """
    Wave 1.8: active sales block deletion (per user decision) but
    soft-deleted history rows do NOT — otherwise operators would be
    permanently un-deletable after any cleanup pass.
    """
    sale = sale_create(
        imei="490154203237518",
        phone_model="iPhone 13",
        operator_id=operator.id,
        channel_id=channel.id,
        amount=Decimal("3500000"),
    )
    # First attempt refused while the sale is active.
    with pytest.raises(ValidationError):
        operator_delete(operator=operator, user=None)

    # Soft-delete the sale and try again.
    sale.is_deleted = True
    sale.deleted_at = timezone.now()
    sale.save(update_fields=["is_deleted", "deleted_at"])

    op_id = operator.id
    operator_delete(operator=operator, user=None)
    assert not Operator.objects.filter(pk=op_id).exists()


@pytest.mark.django_db
def test_operator_delete_bulk_audit(operator, channel):
    """
    Wave 1.2: one audit entry summarises everything the delete detached —
    SaleOperator rows, unlinked Sale rows, unlinked Profile rows, deleted
    PayrollRule rows. Without this, the bulk delete was invisible in the
    audit trail.
    """
    # Attach a PayrollRule so it shows up in the counts.
    PayrollRule.objects.create(
        scope="operator",
        operator=operator,
        threshold=Decimal("50000000"),
        payout_type="percent",
        payout_value=Decimal("3.0"),
    )
    # No live sales (soft-delete a legacy one so the delete is allowed).
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
    operator_delete(operator=operator, user=None)

    entry = AuditLog.objects.get(
        entity="operators.Operator",
        entity_id=str(op_id),
        action="delete",
    )
    changes = entry.changes
    assert "snapshot" in changes
    counts = changes["deleted_related"]
    assert counts["payroll_rules_deleted"] == 1
    # SaleOperator lines are created inside sale_create only when >1 operator
    # shares a sale; the single-operator legacy path doesn't add one. So the
    # count is 0 here — the important thing is the key exists.
    assert "sale_operator_rows_deleted" in counts
    assert counts["sales_unlinked"] == 1  # the soft-deleted sale gets detached too
    assert "profiles_unlinked" in counts

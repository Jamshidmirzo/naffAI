"""
lead_convert_to_sale must refuse a second conversion on the same lead:
- first call creates a Sale, marks lead WON
- second call raises ApplicationError instead of silently duplicating

Edge cases exercised:
- soft-deleted first sale does NOT block a re-conversion (that's how we
  recover from a mis-created sale — soft-delete it, redo)
"""

from __future__ import annotations

from decimal import Decimal

import pytest
from django.utils import timezone

from apps.catalog.models import Channel
from apps.common.exceptions import ApplicationError
from apps.leads.models import LeadStatus
from apps.leads.services import lead_convert_to_sale, lead_create
from apps.operators.models import Operator, OperatorStatus


@pytest.fixture
def op(db):
    return Operator.objects.create(full_name="Op", status=OperatorStatus.ACTIVE)


@pytest.fixture
def channel(db):
    return Channel.objects.create(name="Alif")


@pytest.mark.django_db
def test_lead_convert_to_sale_rejects_double_conversion(op, channel):
    lead = lead_create(full_name="Ivan", phone="+998900001122", auto_assign=False)
    lead.operator = op
    lead.save(update_fields=["operator"])

    lead_convert_to_sale(
        lead=lead,
        sale_data={
            "imei": "490154203237518",
            "phone_model": "iPhone 15",
            "channel_id": channel.id,
            "amount": Decimal("4500000"),
        },
    )
    lead.refresh_from_db()
    assert lead.status == LeadStatus.WON
    assert lead.sales.count() == 1

    with pytest.raises(ApplicationError) as exc:
        lead_convert_to_sale(
            lead=lead,
            sale_data={
                "imei": "356938035643809",
                "phone_model": "iPhone 15",
                "channel_id": channel.id,
                "amount": Decimal("4500000"),
            },
        )
    assert "уже конвертирован" in str(exc.value)
    assert lead.sales.count() == 1  # unchanged


@pytest.mark.django_db
def test_lead_convert_to_sale_allowed_after_soft_delete_of_first_sale(op, channel):
    """
    Recovery path: if a manager soft-deletes the mis-created sale, the
    lead should become re-convertible. This is why the guard checks
    ``is_deleted=False`` instead of any sales at all.
    """
    lead = lead_create(full_name="Ivan", phone="+998900001133", auto_assign=False)
    lead.operator = op
    lead.save(update_fields=["operator"])

    first = lead_convert_to_sale(
        lead=lead,
        sale_data={
            "imei": "490154203237518",
            "phone_model": "iPhone 15",
            "channel_id": channel.id,
            "amount": Decimal("4500000"),
        },
    )
    # Soft-delete the first sale.
    first.is_deleted = True
    first.deleted_at = timezone.now()
    first.save(update_fields=["is_deleted", "deleted_at"])

    # Second conversion should now be allowed.
    second = lead_convert_to_sale(
        lead=lead,
        sale_data={
            "imei": "356938035643809",
            "phone_model": "iPhone 15 Pro",
            "channel_id": channel.id,
            "amount": Decimal("5500000"),
        },
    )
    assert second.pk != first.pk
    # The lead now has two sales total (1 soft-deleted + 1 live).
    assert lead.sales.count() == 2
    assert lead.sales.filter(is_deleted=False).count() == 1

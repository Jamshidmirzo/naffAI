"""
lead_convert_to_sale delegates to sale_create, links the Sale to the Lead
and flips lead.status to `won`. An audit entry is written for the lead.
"""

from __future__ import annotations

from decimal import Decimal

import pytest

from apps.audit.models import AuditLog
from apps.catalog.models import Channel
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
def test_convert_creates_sale_and_marks_lead_won(op, channel):
    lead = lead_create(
        full_name="Ivan", phone="+998900001122", auto_assign=False
    )
    lead.operator = op
    lead.save(update_fields=["operator"])

    sale = lead_convert_to_sale(
        lead=lead,
        sale_data={
            "imei": "490154203237518",
            "phone_model": "iPhone 15",
            "channel_id": channel.id,
            "amount": Decimal("4500000"),
        },
    )

    lead.refresh_from_db()
    sale.refresh_from_db()
    assert sale.lead_id == lead.id
    assert lead.status == LeadStatus.WON
    assert AuditLog.objects.filter(
        entity="leads.Lead", entity_id=str(lead.id)
    ).exists()

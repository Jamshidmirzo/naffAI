"""
Round-robin auto-assignment: skip inactive, skip operators blocked by
overdue callbacks, pick the least-loaded eligible operator.
"""

from __future__ import annotations

import datetime as dt

import pytest
from django.utils import timezone

from apps.calls.services import callback_reminder_create
from apps.common.exceptions import ApplicationError
from apps.leads.models import Lead, LeadAssignmentSource, LeadStatus
from apps.leads.selectors import next_operator_for_round_robin
from apps.leads.services import lead_auto_assign, lead_create
from apps.operators.models import Operator, OperatorStatus


@pytest.fixture
def active_ops(db):
    return [
        Operator.objects.create(full_name=f"OP-{i}", status=OperatorStatus.ACTIVE)
        for i in range(3)
    ]


@pytest.mark.django_db
def test_round_robin_skips_inactive(active_ops):
    active_ops[0].status = OperatorStatus.INACTIVE
    active_ops[0].save()
    picked = next_operator_for_round_robin()
    assert picked is not None
    assert picked.id in (active_ops[1].id, active_ops[2].id)


@pytest.mark.django_db
def test_round_robin_skips_operator_with_overdue_callback(active_ops, settings):
    settings.CALLBACK_OVERDUE_GRACE_MINUTES = 30

    # Give OP-0 a callback that's already >30 minutes in the past.
    lead = Lead.objects.create(
        full_name="", phone="+998900000000", operator=active_ops[0]
    )
    cb = callback_reminder_create(
        lead=lead,
        operator=active_ops[0],
        remind_at=timezone.now() - dt.timedelta(hours=2),
    )
    assert cb.remind_at < timezone.now() - dt.timedelta(minutes=30)

    picked = next_operator_for_round_robin()
    assert picked is not None
    assert picked.id != active_ops[0].id


@pytest.mark.django_db
def test_round_robin_picks_least_loaded(active_ops):
    # Load OP-0 with several active leads; expect OP-1 or OP-2 chosen.
    for _ in range(3):
        Lead.objects.create(
            full_name="",
            phone="+998900000000",
            operator=active_ops[0],
            status=LeadStatus.ASSIGNED,
        )
    picked = next_operator_for_round_robin()
    assert picked is not None
    assert picked.id != active_ops[0].id


@pytest.mark.django_db
def test_lead_auto_assign_creates_assignment(active_ops):
    lead = lead_create(phone="+998900000001", full_name="Test", auto_assign=False)
    assignment = lead_auto_assign(lead=lead)
    lead.refresh_from_db()
    assert lead.operator_id == assignment.operator_id
    assert lead.status == LeadStatus.ASSIGNED
    assert assignment.source == LeadAssignmentSource.AUTO_ROUND_ROBIN


@pytest.mark.django_db
def test_lead_auto_assign_raises_when_nobody_eligible(db, settings):
    # Only trainee (skipped by our policy which requires status=active)
    Operator.objects.create(full_name="Trainee", status=OperatorStatus.TRAINEE)
    lead = lead_create(phone="+998900000002", auto_assign=False)
    with pytest.raises(ApplicationError):
        lead_auto_assign(lead=lead)

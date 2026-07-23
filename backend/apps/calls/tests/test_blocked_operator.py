"""
Operator with at least one callback whose `remind_at + grace_minutes` has
passed must be filtered out of the auto-assignment pool.
"""

from __future__ import annotations

import datetime as dt

import pytest
from django.utils import timezone

from apps.calls.services import callback_reminder_create
from apps.leads.models import Lead
from apps.leads.selectors import (
    operator_is_blocked_by_overdue_callbacks,
    operators_eligible_for_new_leads,
)
from apps.operators.models import Operator, OperatorStatus


@pytest.mark.django_db
def test_operator_is_blocked_when_overdue_past_grace(db, settings):
    settings.CALLBACK_OVERDUE_GRACE_MINUTES = 30
    op = Operator.objects.create(full_name="Slow", status=OperatorStatus.ACTIVE)
    lead = Lead.objects.create(full_name="L", phone="+998900002233", operator=op)

    callback_reminder_create(
        lead=lead,
        operator=op,
        remind_at=timezone.now() - dt.timedelta(hours=2),
    )
    assert operator_is_blocked_by_overdue_callbacks(op) is True
    assert op.id not in list(
        operators_eligible_for_new_leads().values_list("id", flat=True)
    )


@pytest.mark.django_db
def test_operator_not_blocked_within_grace(db, settings):
    settings.CALLBACK_OVERDUE_GRACE_MINUTES = 30
    op = Operator.objects.create(full_name="OK", status=OperatorStatus.ACTIVE)
    lead = Lead.objects.create(full_name="L", phone="+998900001122", operator=op)

    # 5 minutes past remind_at, well inside the grace window
    callback_reminder_create(
        lead=lead,
        operator=op,
        remind_at=timezone.now() - dt.timedelta(minutes=5),
    )
    assert operator_is_blocked_by_overdue_callbacks(op) is False


@pytest.mark.django_db
def test_future_callback_never_blocks(db, settings):
    settings.CALLBACK_OVERDUE_GRACE_MINUTES = 30
    op = Operator.objects.create(full_name="OK", status=OperatorStatus.ACTIVE)
    lead = Lead.objects.create(full_name="L", phone="+998900001122", operator=op)

    callback_reminder_create(
        lead=lead,
        operator=op,
        remind_at=timezone.now() + dt.timedelta(hours=4),
    )
    assert operator_is_blocked_by_overdue_callbacks(op) is False

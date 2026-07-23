"""
- creating a new callback on a lead supersedes any live one
- overdue promotion after grace window
- done / snooze happy paths
"""

from __future__ import annotations

import datetime as dt

import pytest
from django.utils import timezone

from apps.calls.models import CallbackReminderStatus
from apps.calls.services import (
    callback_mark_overdue,
    callback_reminder_complete,
    callback_reminder_create,
    callback_reminder_snooze,
)
from apps.leads.models import Lead
from apps.operators.models import Operator, OperatorStatus


@pytest.fixture
def lead_and_op(db):
    op = Operator.objects.create(full_name="Op", status=OperatorStatus.ACTIVE)
    lead = Lead.objects.create(full_name="L", phone="+998900002233", operator=op)
    return lead, op


@pytest.mark.django_db
def test_new_reminder_supersedes_previous(lead_and_op):
    lead, op = lead_and_op
    first = callback_reminder_create(
        lead=lead, operator=op, remind_at=timezone.now() + dt.timedelta(hours=1)
    )
    second = callback_reminder_create(
        lead=lead, operator=op, remind_at=timezone.now() + dt.timedelta(hours=2)
    )
    first.refresh_from_db()
    assert first.status == CallbackReminderStatus.SUPERSEDED
    assert second.status == CallbackReminderStatus.PENDING


@pytest.mark.django_db
def test_snooze_pushes_reminder_and_flips_status(lead_and_op):
    lead, op = lead_and_op
    cb = callback_reminder_create(
        lead=lead, operator=op, remind_at=timezone.now() + dt.timedelta(hours=1)
    )
    before = cb.remind_at
    callback_reminder_snooze(reminder=cb, minutes=15)
    cb.refresh_from_db()
    assert cb.status == CallbackReminderStatus.SNOOZED
    assert cb.remind_at > before


@pytest.mark.django_db
def test_done_transitions_to_done(lead_and_op):
    lead, op = lead_and_op
    cb = callback_reminder_create(
        lead=lead, operator=op, remind_at=timezone.now() + dt.timedelta(hours=1)
    )
    callback_reminder_complete(reminder=cb)
    cb.refresh_from_db()
    assert cb.status == CallbackReminderStatus.DONE
    assert cb.done_at is not None


@pytest.mark.django_db
def test_mark_overdue_only_from_pending_or_snoozed(lead_and_op):
    lead, op = lead_and_op
    cb = callback_reminder_create(
        lead=lead, operator=op, remind_at=timezone.now() - dt.timedelta(hours=2)
    )
    callback_mark_overdue(reminder=cb)
    cb.refresh_from_db()
    assert cb.status == CallbackReminderStatus.OVERDUE

    # Idempotent: calling again is a no-op
    callback_mark_overdue(reminder=cb)
    cb.refresh_from_db()
    assert cb.status == CallbackReminderStatus.OVERDUE

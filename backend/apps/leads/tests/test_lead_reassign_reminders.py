"""
When a lead is reassigned to a new operator, any live callback reminders
(PENDING / SNOOZED / OVERDUE) must move with it. Otherwise the old
operator keeps getting DM nudges for a lead that no longer belongs to
them, and the new operator never gets pinged.

Historic / DONE / SUPERSEDED reminders must stay attached to the
operator who originally worked them — that data is audit history.
"""

from __future__ import annotations

import datetime as dt

import pytest
from django.utils import timezone

from apps.audit.models import AuditLog
from apps.calls.models import CallbackReminder, CallbackReminderStatus
from apps.calls.services import callback_reminder_create
from apps.leads.services import lead_create, lead_reassign
from apps.operators.models import Operator, OperatorStatus


@pytest.fixture
def two_ops(db):
    old = Operator.objects.create(full_name="Old Op", status=OperatorStatus.ACTIVE)
    new = Operator.objects.create(full_name="New Op", status=OperatorStatus.ACTIVE)
    return old, new


@pytest.mark.django_db
def test_lead_reassign_moves_active_callbacks_to_new_operator(two_ops):
    old_op, new_op = two_ops
    lead = lead_create(full_name="L", phone="+998900002233", auto_assign=False)
    lead.operator = old_op
    lead.save(update_fields=["operator"])

    reminder = callback_reminder_create(
        lead=lead,
        operator=old_op,
        remind_at=timezone.now() + dt.timedelta(hours=1),
    )
    # Simulate the cron having already DM'd the old operator.
    reminder.dm_sent_at = timezone.now()
    reminder.save(update_fields=["dm_sent_at"])

    lead_reassign(lead=lead, new_operator=new_op, reason="Redistribute")

    reminder.refresh_from_db()
    assert reminder.operator_id == new_op.id
    # dm_sent_at must be cleared so the new operator gets a fresh nudge.
    assert reminder.dm_sent_at is None
    assert reminder.status == CallbackReminderStatus.PENDING

    # Audit entry for the reminder reassignment is written alongside the
    # normal lead-reassignment entry.
    entries = AuditLog.objects.filter(
        entity="calls.CallbackReminder",
        changes__reassigned_to=new_op.id,
    )
    assert entries.exists(), "expected an audit entry for the reminder reassignment"
    entry = entries.first()
    assert entry.changes["count"] == 1


@pytest.mark.django_db
def test_lead_reassign_does_not_touch_historic_reminders(two_ops):
    """DONE / SUPERSEDED reminders belong to whoever worked them — leave them be."""
    old_op, new_op = two_ops
    lead = lead_create(full_name="L2", phone="+998900002244", auto_assign=False)
    lead.operator = old_op
    lead.save(update_fields=["operator"])

    # Live one — should move.
    live = callback_reminder_create(
        lead=lead, operator=old_op, remind_at=timezone.now() + dt.timedelta(hours=1)
    )
    # Manually mark another one done in the past — audit history.
    historic = CallbackReminder.objects.create(
        lead=lead,
        operator=old_op,
        remind_at=timezone.now() - dt.timedelta(days=1),
        status=CallbackReminderStatus.DONE,
        done_at=timezone.now() - dt.timedelta(days=1),
    )

    lead_reassign(lead=lead, new_operator=new_op)

    live.refresh_from_db()
    historic.refresh_from_db()
    assert live.operator_id == new_op.id
    assert historic.operator_id == old_op.id  # untouched


@pytest.mark.django_db
def test_lead_reassign_without_reminders_writes_no_extra_audit(two_ops):
    """If nothing to move, no CallbackReminder audit entry is emitted."""
    old_op, new_op = two_ops
    lead = lead_create(full_name="L3", phone="+998900002255", auto_assign=False)
    lead.operator = old_op
    lead.save(update_fields=["operator"])

    lead_reassign(lead=lead, new_operator=new_op)

    assert not AuditLog.objects.filter(
        entity="calls.CallbackReminder",
        changes__reassigned_to=new_op.id,
    ).exists()

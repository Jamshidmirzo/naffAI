"""
Write-side operations for call attempts and callback reminders.
"""

from __future__ import annotations

import datetime as dt

from django.conf import settings
from django.db import transaction
from django.utils import timezone

from apps.audit.services import AuditAction, audit_log_create
from apps.common.exceptions import ApplicationError
from apps.leads.models import Lead, LeadStatus
from apps.operators.models import Operator

from .models import (
    CallAttempt,
    CallbackReminder,
    CallbackReminderStatus,
    CallOutcome,
)

# ---- Call attempts -------------------------------------------------------

# When a call reports one of these outcomes we automatically move the
# lead into the mapped status so the operator's list reflects reality
# without asking them for a second click.
_OUTCOME_TO_LEAD_STATUS: dict[str, str] = {
    CallOutcome.TALKED_INTERESTED: LeadStatus.IN_PROGRESS,
    CallOutcome.TALKED_CALLBACK: LeadStatus.CALLBACK_SCHEDULED,
    CallOutcome.NO_ANSWER: LeadStatus.NO_ANSWER,
    CallOutcome.WRONG_NUMBER: LeadStatus.LOST,
    CallOutcome.REJECTED: LeadStatus.LOST,
    CallOutcome.TG_ONLY: LeadStatus.CONTACTED_TELEGRAM,
}


@transaction.atomic
def call_attempt_log(
    *,
    user=None,
    lead: Lead,
    operator: Operator,
    outcome: str,
    comment: str = "",
    callback_remind_at: dt.datetime | None = None,
    callback_comment: str = "",
) -> CallAttempt:
    """
    Persist a call attempt. If `outcome == talked_callback` and no
    `callback_remind_at` is supplied, we refuse — the caller has to
    provide a reminder time so we can hold the operator accountable.
    """
    if outcome not in dict(CallOutcome.choices):
        raise ApplicationError("Неизвестный исход звонка", {"field": "outcome"})

    if outcome == CallOutcome.TALKED_CALLBACK and callback_remind_at is None:
        raise ApplicationError(
            "Для исхода «Просят перезвонить» нужно указать время callback'а",
            {"field": "callback_remind_at"},
        )

    attempt = CallAttempt.objects.create(
        lead=lead,
        operator=operator,
        outcome=outcome,
        comment=(comment or "").strip(),
    )
    audit_log_create(
        user=user,
        action=AuditAction.CREATE,
        entity="calls.CallAttempt",
        entity_id=attempt.id,
        changes={
            "lead_id": lead.id,
            "operator_id": operator.id,
            "outcome": outcome,
        },
        comment=comment,
    )

    # Reflect the outcome on the lead's status (idempotent — see
    # `lead_update_status`).
    new_status = _OUTCOME_TO_LEAD_STATUS.get(outcome)
    if new_status and lead.status != new_status:
        from apps.leads.services import lead_update_status

        lead_update_status(lead=lead, status=new_status, user=user, comment=outcome)

    if outcome == CallOutcome.TALKED_CALLBACK:
        callback_reminder_create(
            user=user,
            lead=lead,
            operator=operator,
            remind_at=callback_remind_at,
            comment=callback_comment or comment,
            call_attempt=attempt,
        )

    return attempt


# ---- Callback reminders --------------------------------------------------


@transaction.atomic
def callback_reminder_create(
    *,
    user=None,
    lead: Lead,
    operator: Operator,
    remind_at: dt.datetime,
    comment: str = "",
    call_attempt: CallAttempt | None = None,
) -> CallbackReminder:
    if remind_at is None:
        raise ApplicationError("Укажите время callback'а", {"field": "remind_at"})
    if timezone.is_naive(remind_at):
        remind_at = timezone.make_aware(remind_at, timezone.get_current_timezone())

    # Row-lock the Lead so two parallel callers cannot each read "no active
    # reminder", both create one, and end up with two live rows. `of=("self",)`
    # keeps the lock to the Lead row itself (not the FK targets) — cheap
    # and correct for our access pattern. Sqlite ignores select_for_update
    # silently, which is fine for tests but the real safety net is Postgres.
    lead = Lead.objects.select_for_update(of=("self",)).get(pk=lead.pk)

    # Any currently-live reminder on this lead is superseded — the freshest
    # one wins. We do this in one UPDATE to keep the state machine tight.
    CallbackReminder.objects.filter(
        lead=lead,
        status__in=(
            CallbackReminderStatus.PENDING,
            CallbackReminderStatus.SNOOZED,
            CallbackReminderStatus.OVERDUE,
        ),
    ).update(status=CallbackReminderStatus.SUPERSEDED)

    cb = CallbackReminder.objects.create(
        lead=lead,
        operator=operator,
        remind_at=remind_at,
        comment=(comment or "").strip(),
        call_attempt=call_attempt,
    )
    audit_log_create(
        user=user,
        action=AuditAction.CREATE,
        entity="calls.CallbackReminder",
        entity_id=cb.id,
        changes={
            "lead_id": lead.id,
            "operator_id": operator.id,
            "remind_at": remind_at.isoformat(),
        },
        comment=comment,
    )
    return cb


@transaction.atomic
def callback_reminder_complete(*, reminder: CallbackReminder, user=None) -> CallbackReminder:
    if reminder.status == CallbackReminderStatus.DONE:
        return reminder
    reminder.status = CallbackReminderStatus.DONE
    reminder.done_at = timezone.now()
    reminder.save(update_fields=["status", "done_at", "updated_at"])
    audit_log_create(
        user=user,
        action=AuditAction.UPDATE,
        entity="calls.CallbackReminder",
        entity_id=reminder.id,
        changes={"status": CallbackReminderStatus.DONE},
        comment="Выполнено",
    )
    return reminder


@transaction.atomic
def callback_reminder_snooze(
    *, reminder: CallbackReminder, minutes: int, user=None
) -> CallbackReminder:
    if minutes <= 0:
        raise ApplicationError("Минуты должны быть положительными", {"field": "minutes"})
    # Snooze from whichever is later — the current `remind_at` (if still in
    # the future) or `now()` (if already overdue). This keeps the semantics
    # consistent for both operator scenarios:
    #   1) "I know I'm going to be busy, push me another 15 min"
    #   2) "It just rang, but let me finish this other call — +15 min from now"
    now = timezone.now()
    base = max(now, reminder.remind_at)
    new_remind_at = base + dt.timedelta(minutes=minutes)
    old_remind_at = reminder.remind_at
    reminder.remind_at = new_remind_at
    reminder.status = CallbackReminderStatus.SNOOZED
    reminder.dm_sent_at = None  # re-arm DM
    reminder.save(update_fields=["remind_at", "status", "dm_sent_at", "updated_at"])
    audit_log_create(
        user=user,
        action=AuditAction.UPDATE,
        entity="calls.CallbackReminder",
        entity_id=reminder.id,
        changes={
            "remind_at": {"old": old_remind_at.isoformat(), "new": new_remind_at.isoformat()},
            "status": CallbackReminderStatus.SNOOZED,
        },
        comment=f"Отложен на +{minutes}м",
    )
    return reminder


@transaction.atomic
def callback_mark_overdue(*, reminder: CallbackReminder) -> CallbackReminder:
    """
    Called by the cron loop. No user context — we don't want a synthetic
    'system' user, we just record the transition on the audit trail with
    `user=None`.
    """
    if reminder.status not in (
        CallbackReminderStatus.PENDING,
        CallbackReminderStatus.SNOOZED,
    ):
        return reminder
    reminder.status = CallbackReminderStatus.OVERDUE
    reminder.save(update_fields=["status", "updated_at"])
    audit_log_create(
        user=None,
        action=AuditAction.UPDATE,
        entity="calls.CallbackReminder",
        entity_id=reminder.id,
        changes={"status": CallbackReminderStatus.OVERDUE},
        comment="Автопереход в overdue",
    )
    return reminder


@transaction.atomic
def callback_mark_dm_sent(*, reminder: CallbackReminder) -> None:
    reminder.dm_sent_at = timezone.now()
    reminder.save(update_fields=["dm_sent_at", "updated_at"])


# ---- Policy helpers ------------------------------------------------------


def overdue_cutoff(*, now: dt.datetime | None = None) -> dt.datetime:
    grace = getattr(settings, "CALLBACK_OVERDUE_GRACE_MINUTES", 30)
    return (now or timezone.now()) - dt.timedelta(minutes=grace)

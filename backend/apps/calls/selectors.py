"""
Read-side queries for call attempts and callback reminders.
"""

from __future__ import annotations

import datetime as dt

from django.db.models import QuerySet
from django.utils import timezone

from apps.operators.models import Operator

from .models import (
    CallAttempt,
    CallbackReminder,
    CallbackReminderStatus,
)

ACTIVE_REMINDER_STATUSES = (
    CallbackReminderStatus.PENDING,
    CallbackReminderStatus.SNOOZED,
    CallbackReminderStatus.OVERDUE,
)


def callback_get(pk: int) -> CallbackReminder | None:
    return (
        CallbackReminder.objects.select_related("lead", "operator")
        .filter(pk=pk)
        .first()
    )


def callbacks_for_operator(
    operator: Operator, *, include_done: bool = False
) -> QuerySet[CallbackReminder]:
    qs = CallbackReminder.objects.select_related("lead").filter(operator=operator)
    if not include_done:
        qs = qs.filter(status__in=ACTIVE_REMINDER_STATUSES)
    return qs.order_by("remind_at")


def callbacks_due_soon_for_operator(
    operator: Operator, *, window_seconds: int = 60
) -> QuerySet[CallbackReminder]:
    """
    Reminders that are either already past `remind_at` or will be within
    the next `window_seconds`. Used by the in-app watcher hook.
    """
    now = timezone.now()
    horizon = now + dt.timedelta(seconds=max(0, window_seconds))
    return (
        CallbackReminder.objects.select_related("lead")
        .filter(
            operator=operator,
            status__in=(
                CallbackReminderStatus.PENDING,
                CallbackReminderStatus.SNOOZED,
                CallbackReminderStatus.OVERDUE,
            ),
            remind_at__lte=horizon,
        )
        .order_by("remind_at")
    )


def call_attempts_for_lead(lead_id: int) -> QuerySet[CallAttempt]:
    return (
        CallAttempt.objects.select_related("operator")
        .filter(lead_id=lead_id)
        .order_by("-created_at")
    )


def callbacks_pending_due(*, now: dt.datetime | None = None) -> QuerySet[CallbackReminder]:
    """
    Pending / snoozed reminders whose `remind_at` has already passed.
    Used by the `check_due_callbacks` management command to promote them
    to `overdue` and to fan out Telegram DMs.
    """
    when = now or timezone.now()
    return CallbackReminder.objects.select_related("lead", "operator").filter(
        status__in=(
            CallbackReminderStatus.PENDING,
            CallbackReminderStatus.SNOOZED,
        ),
        remind_at__lte=when,
    )

"""
Read-side queries for call attempts and callback reminders.
"""

from __future__ import annotations

import datetime as dt

from django.db.models import Count, QuerySet
from django.utils import timezone

from apps.operators.models import Operator, OperatorStatus

from .models import (
    CallAttempt,
    CallbackReminder,
    CallbackReminderStatus,
)

# Guardrail: manager could otherwise ask for «5 years» and blow up the
# UI table + serialization time. 92 days ≈ ¼ year, comfortable for
# monthly / quarterly reviews.
OPERATOR_ACTIVITY_MAX_DAYS = 92

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


def operator_activity_report(
    *,
    date_from: dt.date,
    date_to: dt.date,
    operator_ids: list[int] | None = None,
) -> dict:
    """
    Per-operator activity for [date_from, date_to] inclusive (local dates in
    the active TZ, expected `Asia/Tashkent`).

    For each active (non-inactive) operator in the (optionally filtered)
    set, counts:

      - `unique_leads_touched` — number of distinct leads with at least one
        CallAttempt in the period,
      - `calls_total` — total CallAttempt rows in the period,
      - `by_status` — distribution of those distinct leads by their
        *current* `Lead.status` (not the historic value at call time — a
        deliberate simplification, see plan `glittery-knitting-mist.md`).

    Operators with zero activity are still included with zeros, so the UI
    table doesn't have to reason about "why is this operator missing";
    caller can filter them out on the frontend if desired.

    Raises `ValueError` on invalid inputs (bad ordering or too-wide window)
    — API layer maps this to HTTP 400.
    """
    if date_from > date_to:
        raise ValueError("date_from must be <= date_to")
    span_days = (date_to - date_from).days + 1
    if span_days > OPERATOR_ACTIVITY_MAX_DAYS:
        raise ValueError(
            f"date range too wide: {span_days}d > {OPERATOR_ACTIVITY_MAX_DAYS}d limit"
        )

    tz = timezone.get_current_timezone()
    # inclusive right-hand: exclusive-lt of the next day's midnight, so we
    # never miss the 23:59 attempts. `date_to + 1d` is the exclusive bound.
    start_dt = dt.datetime.combine(date_from, dt.time.min, tzinfo=tz)
    end_dt = dt.datetime.combine(
        date_to + dt.timedelta(days=1), dt.time.min, tzinfo=tz
    )

    operators = Operator.objects.exclude(status=OperatorStatus.INACTIVE)
    if operator_ids:
        operators = operators.filter(id__in=operator_ids)
    operators = list(operators.order_by("full_name"))

    # Base attempts queryset — filter by op set + window. Uses existing
    # index `(operator, -created_at)` — fast even for the 92-day cap.
    attempts_qs = CallAttempt.objects.filter(
        created_at__gte=start_dt,
        created_at__lt=end_dt,
        operator_id__in=[o.id for o in operators],
    )

    # (1) per-op total call count in one aggregate.
    calls_by_op = {
        row["operator_id"]: row["n"]
        for row in attempts_qs.values("operator_id").annotate(n=Count("id"))
    }

    # (2) per-op unique lead count + status distribution — one grouped
    # query. Distinct on lead_id inside a values() group is exactly what
    # we want ("how many distinct leads with each current status did this
    # operator touch?"). We do the outer sum in Python to also compute
    # `unique_leads_touched` (=sum of by_status buckets).
    status_rows = (
        attempts_qs.values("operator_id", "lead__status")
        .annotate(leads=Count("lead_id", distinct=True))
        .order_by()
    )

    per_op_status: dict[int, dict[str, int]] = {}
    per_op_unique: dict[int, int] = {}
    for row in status_rows:
        op_id = row["operator_id"]
        status_code = row["lead__status"] or ""
        n_leads = row["leads"]
        per_op_status.setdefault(op_id, {})[status_code] = n_leads
        per_op_unique[op_id] = per_op_unique.get(op_id, 0) + n_leads

    rows = []
    for op in operators:
        rows.append(
            {
                "operator_id": op.id,
                "operator_name": op.full_name,
                "unique_leads_touched": per_op_unique.get(op.id, 0),
                "calls_total": calls_by_op.get(op.id, 0),
                "by_status": per_op_status.get(op.id, {}),
            }
        )

    # Sort by "who worked the most" desc for a good default reading order.
    rows.sort(key=lambda r: (-r["unique_leads_touched"], -r["calls_total"], r["operator_name"]))

    return {
        "period": {
            "from": date_from.strftime("%Y-%m-%d"),
            "to": date_to.strftime("%Y-%m-%d"),
        },
        "rows": rows,
    }


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

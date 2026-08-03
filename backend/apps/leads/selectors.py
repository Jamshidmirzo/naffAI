"""
Read-side queries for the lead domain.

Nothing in this module mutates state — it only builds querysets and
computes derived read models used by the API and by the assignment
services.
"""

from __future__ import annotations

import datetime as dt

from django.conf import settings
from django.db.models import Case, Count, IntegerField, Q, QuerySet, Value, When
from django.utils import timezone

from apps.operators.models import Operator, OperatorStatus

from .models import Lead, OperatorSheetAlias, TelegramLink

# ---- Lead queries ---------------------------------------------------------


# Terminal buckets — a lead in one of these never counts as "active".
# Everything else that lives in LeadStatusLabel and is is_active=True is
# considered active, so manager-created codes (dokonga_keladi, kartsi_yoq,
# waiting_salary, …) don't silently vanish from /my the moment an operator
# sets them.
TERMINAL_LEAD_STATUSES = ("won", "lost", "archived", "needs_review")


def active_lead_status_codes() -> list[str]:
    """
    Dynamic list of statuses that count as "active" for /my, RR
    denominators, funnels, etc. Pulled from LeadStatusLabel so custom
    manager-created codes participate too.

    Kept as a function (not a cached module constant) so status changes
    in the admin take effect immediately without a process restart.
    """
    from .models import LeadStatusLabel

    return list(
        LeadStatusLabel.objects.filter(is_active=True)
        .exclude(code__in=TERMINAL_LEAD_STATUSES)
        .values_list("code", flat=True)
    )


# Backwards-compat alias — some callsites still import the old name. The
# tuple form is preserved so `status__in=ACTIVE_LEAD_STATUSES` continues
# to compile at import time; the values are refreshed on every access.
class _ActiveStatusesProxy:
    """Behaves like a tuple but re-queries the DB on every iteration."""

    def __iter__(self):
        return iter(active_lead_status_codes())

    def __contains__(self, item):
        return item in active_lead_status_codes()

    def __len__(self):
        return len(active_lead_status_codes())

    def __repr__(self):
        return f"ActiveLeadStatuses({active_lead_status_codes()!r})"


ACTIVE_LEAD_STATUSES = _ActiveStatusesProxy()


def lead_get(pk: int) -> Lead | None:
    return (
        Lead.objects.select_related("operator", "sheet_source")
        .filter(pk=pk)
        .first()
    )


def lead_list(
    *,
    status: str | None = None,
    operator_id: int | None = None,
    source: str | None = None,
    sheet_source_id: int | None = None,
    needs_review: bool | None = None,
    phone_invalid: bool | None = None,
    search: str | None = None,
) -> QuerySet[Lead]:
    qs = Lead.objects.select_related("operator", "sheet_source")
    if status:
        qs = qs.filter(status=status)
    if operator_id:
        qs = qs.filter(operator_id=operator_id)
    if source:
        qs = qs.filter(source=source)
    if sheet_source_id:
        qs = qs.filter(sheet_source_id=sheet_source_id)
    if needs_review is not None:
        qs = qs.filter(needs_review=needs_review)
    if phone_invalid is not None:
        qs = qs.filter(phone_invalid=phone_invalid)
    if search:
        qs = qs.filter(
            Q(full_name__icontains=search)
            | Q(phone__icontains=search)
            | Q(phone_raw__icontains=search)
            | Q(product_hint__icontains=search)
        )
    return qs


def orphan_leads(
    *,
    sheet_source_id: int | None = None,
    statuses: list[str] | None = None,
    created_from: dt.datetime | None = None,
    created_to: dt.datetime | None = None,
) -> QuerySet[Lead]:
    """
    Пул «свободных» лидов: без оператора, валидный телефон, не на ревью,
    статус — активный (не терминальный). Основа для менеджерского виджета
    /leads/orphans/ и bulk-reassign.
    """
    workable = active_lead_status_codes()
    if not workable:
        return Lead.objects.none()
    qs = Lead.objects.select_related("sheet_source").filter(
        operator__isnull=True,
        needs_review=False,
        phone_invalid=False,
        status__in=workable,
    )
    if statuses:
        # Пересечение с активным набором — на случай, если менеджер
        # прислал терминальный код (won/lost). Оставляем только
        # действительно раздаваемые.
        allowed = set(workable) & set(statuses)
        qs = qs.filter(status__in=allowed) if allowed else qs.none()
    if sheet_source_id:
        qs = qs.filter(sheet_source_id=sheet_source_id)
    if created_from:
        qs = qs.filter(created_at__gte=created_from)
    if created_to:
        qs = qs.filter(created_at__lte=created_to)
    return qs.order_by("created_at", "id")


def leads_for_operator(
    operator: Operator,
    *,
    status: str | None = None,
    include_archived: bool = False,
    view: str = "active",
) -> QuerySet[Lead]:
    """
    Leads currently assigned to `operator` — used by the operator workstation
    (`/api/leads/my/`).

    `view` filters by the operator-set postpone flag:
      - "active"    (default): only lead where postponed_at IS NULL
      - "postponed": only lead where postponed_at IS NOT NULL
      - "all":       no postpone filter
    """
    qs = Lead.objects.select_related("operator", "sheet_source").filter(
        operator=operator
    )
    if status:
        qs = qs.filter(status=status)
    elif not include_archived:
        qs = qs.filter(status__in=active_lead_status_codes())

    if view == "active":
        qs = qs.filter(postponed_at__isnull=True)
        today_start = timezone.localtime().replace(
            hour=0, minute=0, second=0, microsecond=0
        )
        carry_codes = carry_over_status_codes()
        qs = qs.annotate(
            _carry=Case(
                When(status__in=carry_codes, then=Value(0)),
                default=Value(1),
                output_field=IntegerField(),
            ),
            _morning=Case(
                When(created_at__lt=today_start, then=Value(1)),
                default=Value(0),
                output_field=IntegerField(),
            ),
        )
        return qs.order_by("_carry", "_morning", "-updated_at")
    if view == "postponed":
        qs = qs.filter(postponed_at__isnull=False)
        return qs.order_by("-postponed_at")
    return qs.order_by("-updated_at")


# ---- Operator gating -----------------------------------------------------


def operator_is_blocked_by_overdue_callbacks(operator: Operator) -> bool:
    """
    Returns True if the operator has at least one live callback whose
    `remind_at + grace_minutes` has passed. Used both to gate round-robin
    assignment and to render the red banner on the operator workstation.
    """
    # Local import to keep import-time cycles out of apps.leads → apps.calls.
    from apps.calls.models import CallbackReminder, CallbackReminderStatus

    grace = getattr(settings, "CALLBACK_OVERDUE_GRACE_MINUTES", 30)
    cutoff = timezone.now() - dt.timedelta(minutes=grace)
    return CallbackReminder.objects.filter(
        operator=operator,
        status__in=(
            CallbackReminderStatus.PENDING,
            CallbackReminderStatus.OVERDUE,
            CallbackReminderStatus.SNOOZED,
        ),
        remind_at__lte=cutoff,
    ).exists()


def _callback_due_cutoff():
    """
    Callback blocks RR only when its `remind_at` is now-or-imminent.
    A callback scheduled for «after lunch» (remind_at in a few hours)
    lets the operator keep working morning leads normally; once the
    lookahead window (15 min) reaches remind_at, gate kicks in and
    they finish the callback before RR resumes.
    """
    lookahead = getattr(settings, "CALLBACK_GATE_LOOKAHEAD_MINUTES", 15)
    return timezone.now() + dt.timedelta(minutes=lookahead)


def _morning_gate_enabled() -> bool:
    """
    Kill-switch for the whole morning-gate (callback + blocking-status).
    Set MORNING_GATE_ENABLED=1 in .env to turn it back on. Default off
    so RR just distributes whatever lands, no user-visible lock.
    """
    return bool(getattr(settings, "MORNING_GATE_ENABLED", False))


def operator_has_open_callbacks(operator: Operator) -> bool:
    """
    True only if the operator has a callback whose remind_at is due
    now or within the lookahead window. Future callbacks («перезвонить
    после обеда») don't block morning RR intake.
    """
    if not _morning_gate_enabled():
        return False
    from apps.calls.models import CallbackReminder, CallbackReminderStatus

    return CallbackReminder.objects.filter(
        operator=operator,
        status__in=(
            CallbackReminderStatus.PENDING,
            CallbackReminderStatus.OVERDUE,
            CallbackReminderStatus.SNOOZED,
        ),
        remind_at__lte=_callback_due_cutoff(),
    ).exists()


def operator_open_callbacks_count(operator: Operator) -> int:
    """Due-or-soon callbacks — matches the `has_open_callbacks` window."""
    if not _morning_gate_enabled():
        return 0
    from apps.calls.models import CallbackReminder, CallbackReminderStatus

    return CallbackReminder.objects.filter(
        operator=operator,
        status__in=(
            CallbackReminderStatus.PENDING,
            CallbackReminderStatus.OVERDUE,
            CallbackReminderStatus.SNOOZED,
        ),
        remind_at__lte=_callback_due_cutoff(),
    ).count()


def blocking_lead_status_codes() -> list[str]:
    """
    Codes flagged by the manager as «must be closed before you get new
    ones». Powers the morning gate and the /my lock overlay.
    """
    from .models import LeadStatusLabel

    return list(
        LeadStatusLabel.objects.filter(is_active=True, blocks_new_leads=True)
        .values_list("code", flat=True)
    )


def terminal_lead_status_codes() -> list[str]:
    """
    Terminal codes — lead is done. Excluded from batch quota, /my active
    tab, and RR gate.
    """
    from .models import LeadStatusLabel

    return list(
        LeadStatusLabel.objects.filter(is_active=True, is_terminal=True)
        .values_list("code", flat=True)
    )


def carry_over_status_codes() -> list[str]:
    """
    Codes flagged as «спец-лиды» — оставшиеся в работе с прошлого дня.
    Показываются первыми в /my active: no_answer, phone_on,
    callback_scheduled, contacted_telegram и т.п.
    """
    from .models import LeadStatusLabel

    return list(
        LeadStatusLabel.objects.filter(is_active=True, carry_over_next_day=True)
        .values_list("code", flat=True)
    )


def operator_working_lead_count(operator: Operator) -> int:
    """
    Count of «leads still on operator's plate»: active status, not
    terminal, not postponed. Powers the batch=N gate — while this
    count >= N, RR skips the operator.
    """
    terminal = set(terminal_lead_status_codes())
    all_active = set(active_lead_status_codes())
    workable = list(all_active - terminal)
    if not workable:
        return 0
    return Lead.objects.filter(
        operator=operator,
        status__in=workable,
        postponed_at__isnull=True,
    ).count()


def _rr_batch_size() -> int:
    return int(getattr(settings, "RR_BATCH_SIZE", 5))


def operator_yesterday_backlog_count(operator: Operator) -> int:
    """
    Count of leads holding the operator: any lead in a
    manager-flagged «blocking» status. Time-independent — a phone_on
    lead marked five minutes ago still counts, because that phone
    conversation isn't done. Feeds the /my lock overlay.
    """
    if not _morning_gate_enabled():
        return 0
    # Same rule as operators_eligible_for_new_leads: callback_scheduled
    # is counted only when the reminder is due (via operator_open_callbacks_count).
    codes = [c for c in blocking_lead_status_codes() if c != "callback_scheduled"]
    if not codes:
        return 0
    return Lead.objects.filter(operator=operator, status__in=codes).count()


def operator_has_open_backlog(operator: Operator) -> bool:
    """Union check used by morning gate: open callback OR blocking status."""
    return (
        operator_has_open_callbacks(operator)
        or operator_yesterday_backlog_count(operator) > 0
    )


def operators_eligible_for_new_leads() -> QuerySet[Operator]:
    """
    Active operators eligible for round-robin.

    Batch quota: an operator holding >= RR_BATCH_SIZE working leads
    (active, non-terminal, non-postponed) is skipped — they finish
    their current pack of 5 before RR hands them the next batch.

    When MORNING_GATE_ENABLED=1, additionally excludes anyone with a
    due callback or a blocking-status lead (legacy gate, off by default).
    """
    from django.db.models import Count, Q

    terminal = set(terminal_lead_status_codes())
    workable = list(set(active_lead_status_codes()) - terminal)
    batch = _rr_batch_size()

    qs = (
        Operator.objects.filter(status=OperatorStatus.ACTIVE)
        .annotate(
            _working_count=Count(
                "leads",
                filter=Q(
                    leads__status__in=workable,
                    leads__postponed_at__isnull=True,
                ),
            ),
        )
        .filter(_working_count__lt=batch)
        .order_by("id")
    )

    if not _morning_gate_enabled():
        return qs

    from apps.calls.models import CallbackReminder, CallbackReminderStatus

    cb_blocked = set(
        CallbackReminder.objects.filter(
            status__in=(
                CallbackReminderStatus.PENDING,
                CallbackReminderStatus.OVERDUE,
                CallbackReminderStatus.SNOOZED,
            ),
            remind_at__lte=_callback_due_cutoff(),
        ).values_list("operator_id", flat=True)
    )
    return qs.exclude(pk__in=cb_blocked)


def next_operator_for_round_robin() -> Operator | None:
    """
    Deterministic-ish round-robin: pick the eligible operator with the
    fewest *currently active* leads. Ties broken by lowest id (stable).
    """
    qs = operators_eligible_for_new_leads().annotate(
        active_leads_count=Count(
            "leads",
            filter=Q(leads__status__in=active_lead_status_codes()),
        )
    )
    return qs.order_by("active_leads_count", "id").first()


# ---- Sheet configuration --------------------------------------------------


def alias_lookup(alias_name: str) -> OperatorSheetAlias | None:
    if not alias_name:
        return None
    return OperatorSheetAlias.objects.filter(
        alias_name__iexact=alias_name.strip()
    ).first()


# ---- Telegram link cache --------------------------------------------------


def telegram_link_for_phone(phone: str) -> TelegramLink | None:
    if not phone:
        return None
    return TelegramLink.objects.filter(phone=phone).first()

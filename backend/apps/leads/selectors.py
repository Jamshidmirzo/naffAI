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


def _today_start_local() -> dt.datetime:
    """
    Полночь текущего локального дня (Asia/Tashkent) в виде aware datetime.
    Используем для правила «оператор ещё не трогал лид сегодня» — лид
    считается «активным для сегодня», если `updated_at < today_start`
    или это свежий `new`/`assigned`, который оператор не тронул.
    """
    now_local = timezone.localtime()
    day_start_local = now_local.replace(hour=0, minute=0, second=0, microsecond=0)
    return day_start_local


def _today_lunch_start() -> dt.datetime:
    """
    13:00 Asia/Tashkent сегодня — cutoff для правила `recall_after_lunch`.

    Лид с recall-статусом (no_answer / phone_on), выставленным до этого
    момента, после 13:00 снова считается «активным для сегодня» и
    всплывает наверх /my (intraday-carry). Если оператор повторно тронул
    его после обеда — обычная логика «updated_at сегодня» скроет его до
    завтра.
    """
    now_local = timezone.localtime()
    return now_local.replace(hour=13, minute=0, second=0, microsecond=0)


# Статусы, при которых лид считается «нетронутым» — только что раздали,
# оператор ещё не выставил ни один из бизнес-статусов. Такие лиды всегда
# в «активных на сегодня», даже если updated_at свежее today_start
# (RR-раздача обновляет updated_at).
UNTOUCHED_LEAD_STATUSES = ("new", "assigned")


def _active_today_filter(prefix: str = "") -> Q:
    """
    Q-выражение «лид активен для сегодня» — единый источник правды для
    трёх мест: `operator_working_lead_count`, `leads_for_operator(view=active)`,
    `operators_eligible_for_new_leads` / `operators_distribution_status`.

    Правило:
      1. Untouched (new / assigned) — всегда активен.
      2. `updated_at < today_start` — не тронут сегодня, активен.
      3. Recall-after-lunch: после 13:00 лид с recall-статусом (no_answer
         / phone_on), тронутый до обеда (`updated_at < lunch_start`),
         снова активен. Если тронут ПОСЛЕ обеда — уходит до завтра по
         общему правилу.

    `prefix` — Django lookup-префикс для join-запросов (например `leads__`
    когда фильтруем Operator по связанным Lead). По умолчанию пусто (лид
    в корне queryset'а).
    """
    today_start = _today_start_local()
    now = timezone.localtime()
    lunch_start = _today_lunch_start()
    recall_active_now = now >= lunch_start

    p = prefix
    q = Q(**{f"{p}status__in": UNTOUCHED_LEAD_STATUSES}) | Q(
        **{f"{p}updated_at__lt": today_start}
    )
    if recall_active_now:
        recall_codes = recall_after_lunch_status_codes()
        if recall_codes:
            q |= Q(
                **{
                    f"{p}status__in": recall_codes,
                    f"{p}updated_at__lt": lunch_start,
                }
            )
    return q


def _leads_active_today_filter() -> Q:
    """Shortcut: `_active_today_filter(prefix="leads__")` — для аннотаций Operator."""
    return _active_today_filter(prefix="leads__")


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
                    AND (status ∈ {new, assigned} OR updated_at < сегодня 00:00).
                    Идея: если оператор сегодня тронул лид (любой статус,
                    включая carry_over) — лид «отработан на сегодня» и
                    исчезает из активной вкладки; завтра снова появится.
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
        qs = qs.filter(_active_today_filter())
        carry_codes = carry_over_status_codes()
        now = timezone.localtime()
        lunch_start = _today_lunch_start()
        recall_active_now = now >= lunch_start
        recall_codes = recall_after_lunch_status_codes() if recall_active_now else []
        if not carry_codes and not recall_codes:
            return qs.order_by("-updated_at")
        # Оба класса — carry и recall-after-lunch — идут в топе (значение 0).
        # Внутри «топа» первенство даёт -updated_at (последний тронутый — выше).
        cases: list[When] = []
        if carry_codes:
            cases.append(When(status__in=carry_codes, then=Value(0)))
        if recall_codes:
            cases.append(
                When(
                    status__in=recall_codes,
                    updated_at__lt=lunch_start,
                    then=Value(0),
                )
            )
        qs = qs.annotate(
            _top=Case(*cases, default=Value(1), output_field=IntegerField()),
        )
        return qs.order_by("_top", "-updated_at")
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

    Кэш 60с — набор редко меняется (только через админ), а вызывается
    на каждом GET /api/leads/my/.
    """
    from django.core.cache import cache

    from .models import LeadStatusLabel

    cached = cache.get("carry_over_status_codes")
    if cached is not None:
        return cached
    codes = list(
        LeadStatusLabel.objects.filter(is_active=True, carry_over_next_day=True)
        .values_list("code", flat=True)
    )
    cache.set("carry_over_status_codes", codes, 60)
    return codes


def recall_after_lunch_status_codes() -> list[str]:
    """
    Codes с флагом `recall_after_lunch=True` — статусы, лиды с которыми
    после 13:00 (Asia/Tashkent) снова становятся активными для сегодня
    (intraday-carry). По умолчанию — no_answer, phone_on.

    Кэш 60с — набор меняется только через админку.
    """
    from django.core.cache import cache

    from .models import LeadStatusLabel

    cached = cache.get("recall_after_lunch_status_codes")
    if cached is not None:
        return cached
    codes = list(
        LeadStatusLabel.objects.filter(is_active=True, recall_after_lunch=True)
        .values_list("code", flat=True)
    )
    cache.set("recall_after_lunch_status_codes", codes, 60)
    return codes


def stale_leads_for_auto_close() -> QuerySet[Lead]:
    """
    Non-carry лиды у активных операторов, где `updated_at < сегодня 00:00`
    (Asia/Tashkent) и статус — активный, но НЕ carry-over и НЕ untouched
    (new/assigned). Утренний cron (`auto_close_stale_leads`) переводит их
    в `LOST`, чтобы мёртвые хвосты `has_debt`/`shunchaki_qiziqdi`/… не
    копились на плечах оператора.

    Идея: сегодня оператор что-то сделал с лидом (updated_at обновился),
    завтра либо это carry (специально продолжает работать), либо
    закрывается автоматически как LOST.

    Свежие лиды (`new`, `assigned`) не трогаем — они просто ждут первого
    контакта. Postponed — оператор явно попросил отложить, тоже мимо.
    """
    today_start = _today_start_local()
    active = set(active_lead_status_codes())
    carry = set(carry_over_status_codes())
    recall = set(recall_after_lunch_status_codes())
    # Recall-статусы (no_answer / phone_on) не auto-close'им: их
    # lifecycle intraday (утром → recall после обеда), а на следующий
    # день они уже carry (carry_over_next_day тоже стоит). Оставлять их
    # в auto-close задвоило бы правило.
    stale_codes = [
        c
        for c in active
        if c not in carry
        and c not in recall
        and c not in UNTOUCHED_LEAD_STATUSES
    ]
    if not stale_codes:
        return Lead.objects.none()
    return Lead.objects.filter(
        status__in=stale_codes,
        updated_at__lt=today_start,
        operator__isnull=False,
        postponed_at__isnull=True,
    ).select_related("operator")


def operator_working_lead_count(operator: Operator) -> int:
    """
    Count of «leads still on operator's plate for today»: active status,
    not terminal, not postponed, и **лид ещё не тронут сегодня** —
    иначе оператор мог обработать всю пачку и всё равно остался бы
    «busy» до конца дня, и RR никогда бы его не долил.

    Новое правило:
      lead in count ↔
        status in active_lead_status_codes() minus terminal
        AND postponed_at IS NULL
        AND (status in {new, assigned} OR updated_at < today_start)

    Тронутые сегодня carry-статусы (no_answer, phone_on, callback_scheduled,
    contacted_telegram, dokonga_keladi, …) исчезают из «сегодня-плеч»
    сразу после того, как оператор их выставил, но завтра снова всплывают
    (updated_at < today_start новый), поэтому оператор снова получит их
    в /my active первыми.

    Powers the batch=N gate: while this count >= N, RR skips the operator.
    """
    terminal = set(terminal_lead_status_codes())
    all_active = set(active_lead_status_codes())
    workable = list(all_active - terminal)
    if not workable:
        return 0
    return (
        Lead.objects.filter(
            operator=operator,
            status__in=workable,
            postponed_at__isnull=True,
        )
        .filter(_active_today_filter())
        .count()
    )


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
    (active, non-terminal, non-postponed, **и ещё не тронутых сегодня**)
    is skipped — они добивают текущую «сегодня-пачку» до того, как RR
    подкинет следующую. Как только оператор сегодня закрыл/обработал
    все свои лиды, _working_count падает до 0 и он снова становится
    eligible → приходит новая пачка.

    When MORNING_GATE_ENABLED=1, additionally excludes anyone with a
    due callback or a blocking-status lead (legacy gate, off by default).
    """
    from django.db.models import Count, Q

    terminal = set(terminal_lead_status_codes())
    workable = list(set(active_lead_status_codes()) - terminal)
    batch = _rr_batch_size()
    active_today = _leads_active_today_filter()

    qs = (
        Operator.objects.filter(status=OperatorStatus.ACTIVE)
        .annotate(
            _working_count=Count(
                "leads",
                filter=Q(
                    leads__status__in=workable,
                    leads__postponed_at__isnull=True,
                )
                & active_today,
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


def operators_distribution_status() -> list[dict]:
    """
    Диагностическая сводка для менеджера: по каждому оператору со
    `status=ACTIVE` — сколько сейчас лидов на плечах и почему он
    (не) участвует в круге раздачи `operators_eligible_for_new_leads()`.

    Порядок: сначала eligible (по working_count ASC, ties — id ASC),
    потом non-eligible (по working_count DESC, ties — id ASC), чтобы
    менеджер сразу видел «кто перегружен».

    Возвращает список словарей с полями:
      - id, full_name, status
      - working_count   (то же, что `operator_working_lead_count`)
      - postponed_count
      - eligible        (bool)
      - reason          (str, RU) — «ок» если eligible, иначе причина
    """
    batch = _rr_batch_size()
    morning_gate = _morning_gate_enabled()

    terminal = set(terminal_lead_status_codes())
    workable = list(set(active_lead_status_codes()) - terminal)
    active_today = _leads_active_today_filter()

    ops = list(
        Operator.objects.filter(status=OperatorStatus.ACTIVE)
        .annotate(
            # «сегодня-плечи»: активные, не отложенные, не тронутые сегодня.
            _working_count=Count(
                "leads",
                filter=Q(
                    leads__status__in=workable,
                    leads__postponed_at__isnull=True,
                )
                & active_today,
            ),
            _postponed_count=Count(
                "leads",
                filter=Q(
                    leads__status__in=workable,
                    leads__postponed_at__isnull=False,
                ),
            ),
        )
        .order_by("id")
    )

    rows: list[dict] = []
    for op in ops:
        working = op._working_count  # type: ignore[attr-defined]
        postponed = op._postponed_count  # type: ignore[attr-defined]

        reasons: list[str] = []
        if working >= batch:
            reasons.append(
                f"Квота: {working}/{batch} — освободите слот, закрыв лид"
            )
        if morning_gate and operator_has_open_callbacks(op):
            reasons.append("morning-gate: есть просроченный callback")
        if morning_gate and operator_yesterday_backlog_count(op) > 0:
            reasons.append("morning-gate: блокирующий статус на лиде")

        eligible = not reasons
        rows.append(
            {
                "id": op.id,
                "full_name": op.full_name,
                "status": op.status,
                "working_count": working,
                "postponed_count": postponed,
                "eligible": eligible,
                "reason": "ок — участвует в RR" if eligible else "; ".join(reasons),
            }
        )

    # Eligible сверху (по working ASC), затем non-eligible (по working DESC).
    rows.sort(
        key=lambda r: (
            0 if r["eligible"] else 1,
            r["working_count"] if r["eligible"] else -r["working_count"],
            r["id"],
        )
    )
    return rows


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

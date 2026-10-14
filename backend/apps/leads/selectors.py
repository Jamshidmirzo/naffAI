"""
Read-side queries for the lead domain.

Nothing in this module mutates state — it only builds querysets and
computes derived read models used by the API and by the assignment
services.
"""

from __future__ import annotations

import datetime as dt

from django.conf import settings
from django.db.models import (
    Case,
    Count,
    DateTimeField,
    IntegerField,
    OuterRef,
    Q,
    QuerySet,
    Subquery,
    Value,
    When,
)
from django.utils import timezone

from apps.operators.models import Operator, OperatorStatus

from .models import Lead, OperatorSheetAlias, SheetSource, TelegramLink

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
    return Lead.objects.select_related("operator", "sheet_source").filter(pk=pk).first()


def lead_list(
    *,
    status: str | None = None,
    operator_id: int | None = None,
    source: str | None = None,
    sheet_source_id: int | None = None,
    needs_review: bool | None = None,
    phone_invalid: bool | None = None,
    search: str | None = None,
    visible_operator_ids: list[int] | None = None,
) -> QuerySet[Lead]:
    """
    List leads with the usual filters, and (optionally) an ownership scope.

    `visible_operator_ids` — allowlist of operator ids the caller may see
    (see `apps.users.selectors.visible_operator_ids`). The scope matches
    leads whose `operator_id` is in the list OR unassigned (`NULL`),
    because the orphan pool is always visible to managers so they can
    distribute leads to their team.

    Pass `None` to skip the ownership gate (superadmin / internal use).
    An empty list restricts the view to orphan leads only (operator is
    NULL) — a super_manager with zero operators can still triage the
    unassigned pool.
    """
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
    if visible_operator_ids is not None:
        qs = qs.filter(
            Q(operator_id__in=visible_operator_ids) | Q(operator__isnull=True)
        )
    return qs


def leads_by_phone_search(q_digits: str, *, limit: int = 10) -> QuerySet[Lead]:
    """
    Substring search on `phone` (normalized `+998…`) and `phone_raw`
    (original sheet value) — used by the SaleCreate phone autocomplete.
    Accepts already-stripped digits; the caller normalizes.
    """
    q_digits = (q_digits or "").strip()
    if len(q_digits) < 4:
        return Lead.objects.none()
    return (
        Lead.objects.select_related("operator", "sheet_source")
        .filter(Q(phone__icontains=q_digits) | Q(phone_raw__icontains=q_digits))
        .order_by("-updated_at")[:limit]
    )


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


# ---- Rescue: «пропавшие лиды» --------------------------------------------
#
# 3 отдельных селектора для менеджерских виджетов + rescue-команды:
#
#   * needs_review_leads() — 74 сироты с needs_review=True (обычно битые
#     телефоны из sheet_source=4). orphan_leads() их скрывает, потому что
#     туда попадают только «раздаваемые». Здесь — «требуют ручного триажа».
#
#   * stranded_untouched_leads() — untouched (`new`/`assigned`) на inactive-
#     операторе. Быстрый путь возврата в пул: автораздача сама разберёт.
#
#   * stranded_touched_non_terminal_leads() — non-terminal, не untouched, на
#     inactive-операторе. Требует ручного триажа (потому что если ткнуть
#     `in_progress` в общий пул, следующий оператор позвонит клиенту «с
#     начала», потеряется контекст).
#
# Все три исключают terminal-статусы (won / lost / archived / needs_review-
# на-активе).


def needs_review_leads() -> QuerySet[Lead]:
    """
    Сироты в needs_review — нужен ручной триаж менеджером (обычно битый
    телефон из sheet-строки). Отличие от `orphan_leads()`: тот фильтрует
    `needs_review=False`, а здесь — наоборот.
    """
    return (
        Lead.objects.select_related("sheet_source", "operator")
        .filter(needs_review=True, operator__isnull=True)
        .order_by("created_at", "id")
    )


def stranded_untouched_leads(*, operator_id: int | None = None) -> QuerySet[Lead]:
    """
    Untouched-лиды (`new` / `assigned`), застрявшие на inactive-операторах.
    Быстрый путь: rescue → operator=NULL, автораздача разберёт.

    `operator_id` — сузить до одного оператора (для per-op транзакций
    в rescue-команде).
    """
    qs = Lead.objects.select_related("operator", "sheet_source").filter(
        operator__status=OperatorStatus.INACTIVE,
        status__in=list(UNTOUCHED_LEAD_STATUSES),
    )
    if operator_id is not None:
        qs = qs.filter(operator_id=operator_id)
    return qs.order_by("id")


def stranded_touched_non_terminal_leads(
    *, operator_id: int | None = None
) -> QuerySet[Lead]:
    """
    Non-terminal touched лиды на inactive-операторах (in_progress /
    no_answer* / phone_on / has_debt / callback_scheduled / …).

    «Terminal» тянем из LeadStatusLabel (`is_terminal=True`) + hard-coded
    fallback `TERMINAL_LEAD_STATUSES` — чтобы селектор работал даже до
    того, как загружен catalog LeadStatusLabel'ей.

    «Untouched» (new / assigned) исключаем — для них более быстрый путь
    в `stranded_untouched_leads()` (сразу в пул без needs_review).
    """
    terminal_codes = set(TERMINAL_LEAD_STATUSES)
    try:
        terminal_codes |= set(terminal_lead_status_codes())
    except Exception:
        # LeadStatusLabel ещё не мигрирован — оставим только hard-coded.
        pass
    excluded = terminal_codes | set(UNTOUCHED_LEAD_STATUSES)
    qs = Lead.objects.select_related("operator", "sheet_source").filter(
        operator__status=OperatorStatus.INACTIVE,
    ).exclude(status__in=excluded)
    if operator_id is not None:
        qs = qs.filter(operator_id=operator_id)
    return qs.order_by("id")


def stranded_on_inactive_operators() -> QuerySet[Lead]:
    """
    Union: все non-terminal лиды на inactive-операторах (untouched + touched).
    Используется для менеджерского счётчика «Зависли на уволенных: N» +
    новый чип в /leads/orphans?kind=stranded.
    """
    terminal_codes = set(TERMINAL_LEAD_STATUSES)
    try:
        terminal_codes |= set(terminal_lead_status_codes())
    except Exception:
        pass
    return (
        Lead.objects.select_related("operator", "sheet_source")
        .filter(operator__status=OperatorStatus.INACTIVE)
        .exclude(status__in=terminal_codes)
        .order_by("id")
    )


# ---- System-lost leads --------------------------------------------------
#
# «Системно потерянные» — лиды, которые мы закрыли автоматически, не потому
# что клиент отказался, а потому что они «зависли» по системной причине:
#   * `stranded_on_inactive_operator` — оператор уволен, а лид уже
#     «трогали» (in_progress / no_answer / phone_on / has_debt / …).
#     Мы не можем прозрачно передать их новому оператору, поэтому
#     помечаем как lost с сохранением original_operator_name.
#   * `invalid_phone_from_sheet` — needs_review-сироты с битой sheet-
#     строкой (телефон не прошёл normalize_uz_phone). Клиенту не
#     позвонить, значит бизнес-возможности нет.
#
# Хранение: обычный status='lost' + `metadata['lost_reason']`. Ключ
# `lost_reason` — источник правды: он же используется в `exclude_system_lost()`
# чтобы отфильтровать эти записи из аналитики (иначе они смещают статистику
# real lost'ов, которых до сих пор порядка 7к).


LOST_REASON_STRANDED = "stranded_on_inactive_operator"
LOST_REASON_INVALID_PHONE = "invalid_phone_from_sheet"

# Все известные reason'ы — используется в API-фильтре ?reason=... для
# валидации входного значения.
KNOWN_LOST_REASONS = (LOST_REASON_STRANDED, LOST_REASON_INVALID_PHONE)


def exclude_system_lost(qs: QuerySet[Lead]) -> QuerySet[Lead]:
    """
    Убираем из выборки лиды, которые мы автоматически пометили как lost
    из-за системной причины (не реальный отказ клиента).

    Используется в аналитических селекторах (`lead_stats_snapshot`,
    `funnel_by_source`, `rejection_reasons_by_source`, `lost_by_day`) —
    везде, где мы отдельно считаем «lost'ы за период» и не хотим,
    чтобы 556 разовых системных закрытий 2026-09-02 портили распределение.

    Реализация: `metadata->lost_reason IS NOT NULL`. PostgreSQL JSONB
    `__isnull=False` работает как ожидается — ключ отсутствует / null
    → фильтр не сработает, наши system-lost всегда имеют строковое значение.
    """
    return qs.exclude(metadata__lost_reason__isnull=False)


def system_lost_leads_qs(
    *,
    reason: str | None = None,
    date_from: dt.datetime | None = None,
    date_to: dt.datetime | None = None,
    original_operator_name: str | None = None,
) -> QuerySet[Lead]:
    """
    Обратный фильтр `exclude_system_lost` — только system-lost лиды.

    Используется страницей `/leads/system-lost` (superadmin-only):
    таблица + фильтры + кнопка «Восстановить».

    `date_from` / `date_to` матчатся по `metadata__lost_at` (ISO-строка,
    сортируется лексикографически поскольку always same TZ offset).
    Если менеджер прислал только один из двух — второй open-ended.
    """
    qs = (
        Lead.objects.select_related("sheet_source", "operator")
        .filter(metadata__lost_reason__isnull=False)
    )
    if reason:
        qs = qs.filter(metadata__lost_reason=reason)
    if original_operator_name:
        qs = qs.filter(
            metadata__lost_original_operator_name=original_operator_name
        )
    # ISO-строка `2026-09-02T14:30:00+05:00` — упорядоченная лексикографически
    # (пока TZ offset одинаковый; у нас всё в Asia/Tashkent — стабильно).
    if date_from is not None:
        qs = qs.filter(metadata__lost_at__gte=date_from.isoformat())
    if date_to is not None:
        qs = qs.filter(metadata__lost_at__lte=date_to.isoformat())
    return qs.order_by("-updated_at", "-id")


def system_lost_summary() -> dict:
    """
    Сводка для sidebar / чипов на странице `/leads/system-lost`:
    сколько всего, сколько по каждому reason'у, топ-5 original_operator'ов.
    Дёшево: несколько aggregate-запросов.
    """
    from collections import Counter

    total = Lead.objects.filter(metadata__lost_reason__isnull=False).count()
    by_reason: dict[str, int] = {}
    for reason in KNOWN_LOST_REASONS:
        by_reason[reason] = Lead.objects.filter(
            metadata__lost_reason=reason
        ).count()

    # Топ-5 оригинальных операторов (только для stranded — invalid_phone
    # никогда не имел оператора). Читаем metadata json-полем в Python:
    # JSONB group-by поддерживается, но накладно писать миграцию под индекс.
    orig_ops_qs = (
        Lead.objects.filter(metadata__lost_reason=LOST_REASON_STRANDED)
        .values_list("metadata", flat=True)
    )
    counter: Counter[str] = Counter()
    for meta in orig_ops_qs:
        name = (meta or {}).get("lost_original_operator_name")
        if name:
            counter[str(name)] += 1
    top_original_operators = [
        {"name": name, "count": cnt} for name, cnt in counter.most_common(5)
    ]

    return {
        "total": total,
        "by_reason": by_reason,
        "top_original_operators": top_original_operators,
    }


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
    q = Q(**{f"{p}status__in": UNTOUCHED_LEAD_STATUSES}) | Q(**{f"{p}updated_at__lt": today_start})
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
      - "closed":    terminal-статусы (won / lost / archived / needs_review /
                    kartsi_yoq / harid_qildi / sms_jonatildi / has_debt /
                    contacted_telegram / qimmatlik_qildi / waiting_salary /
                    notogri_raqam …). История работы оператора — только для
                    чтения, никаких контрол-кнопок в UI. Сортировка по
                    `-updated_at` (последнее закрытое сверху).
      - "all":       no postpone filter
    """
    # Annotate когда оператор получил лид — активная LeadAssignment.created_at.
    # Используется в LeadSerializer.get_assigned_at (fast path без доп-запроса).
    from .models import LeadAssignment

    assigned_at_sq = (
        LeadAssignment.objects.filter(
            lead=OuterRef("pk"),
            operator_id=operator.id,
            active=True,
        )
        .order_by("-created_at")
        .values("created_at")[:1]
    )
    qs = (
        Lead.objects.select_related("operator", "sheet_source")
        .annotate(assigned_at_annot=Subquery(assigned_at_sq, output_field=DateTimeField()))
        .filter(operator=operator)
    )

    # `closed` — история терминальных лидов. Обходим общий active-filter
    # ниже, потому что include_archived/status там сузили бы выборку до
    # активных кодов (у terminal-лидов другая семантика — они и так
    # закрыты, оператор их только смотрит).
    if view == "closed":
        return qs.filter(status__in=terminal_lead_status_codes()).order_by("-updated_at")

    if status:
        qs = qs.filter(status=status)
    elif not include_archived:
        qs = qs.filter(status__in=active_lead_status_codes())

    if view == "active":
        qs = qs.filter(postponed_at__isnull=True)
        # Note: We intentionally do NOT filter out leads updated today, so that active leads
        # remain in the operator's active workstation tab ("Faol") always after processing.
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

    Respects `_gate_active_for_operator`: если гейт неактивен для этого
    оператора (глобальный switch OFF или per-op flag OFF) — возвращает
    False, чтобы UI и API-фасад не показывали блокировочный баннер.
    """
    if not _gate_active_for_operator(operator):
        return False
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

    Порядок приоритетов:
      1. settings.MORNING_GATE_ENABLED (bool или None) — если явно задан
         в env, побеждает. Используется в тестах через
         `@override_settings(MORNING_GATE_ENABLED=False)` и как emergency-
         off, если БД недоступна.
      2. `SystemSetting.morning_gate_enabled` (singleton в БД, default=True) —
         менеджерский toggle из UI. По умолчанию гейт **включён**.

    Раньше kill-switch жил только в env и был выключен по умолчанию
    (`a19e40e feat(gate): kill-switch — morning gate off by default`).
    Теперь по бизнес-запросу «вернуть блокировку когда есть спец-лиды»
    гейт снова активен, а менеджер может выключить его через `/settings`
    без деплоя.

    NB. Даже когда глобальный switch ON, **факт применения гейта к
    конкретному оператору** контролируется его флагом
    `Operator.blocking_gate_enabled`. Это глобальное — «включён ли гейт
    как механизм», а не «блокировать ли всех». См.
    `_gate_active_for_operator()`.
    """
    override = getattr(settings, "MORNING_GATE_ENABLED", None)
    if override is not None:
        return bool(override)
    # Local import — apps.leads не должен зависеть от system_settings
    # на уровне модуля (циклы + test-loading order).
    from apps.system_settings.selectors import morning_gate_enabled as _db_toggle

    try:
        return _db_toggle()
    except Exception:  # БД недоступна / migrations не прогнаны
        # Безопасный fallback: гейт считаем ОТКЛЮЧЁННЫМ, чтобы RR
        # продолжал раздавать, а не встал колом.
        return False


def _gate_active_for_operator(operator: Operator) -> bool:
    """
    Effective gate: global switch AND per-operator opt-in.

    Both must be True for the morning-gate (callback + blocking-status)
    to apply to `operator`.

      - global switch OFF → gate never applies (ни для кого).
      - global switch ON + operator flag OFF → «prod-безопасно», оператор
        всегда получает новых лидов, никаких блокирующих баннеров.
      - global switch ON + operator flag ON  → gate applies as before
        (используется для тестовых/демо-операторов).

    Rollout plan (2026-08-16): по умолчанию флаг у всех False → prod
    unaffected; менеджер вручную включает у тестовых на demo, обкатывает
    UX, потом уже раскатывает шире.
    """
    if not _morning_gate_enabled():
        return False
    return bool(getattr(operator, "blocking_gate_enabled", False))


def operator_has_open_callbacks(operator: Operator) -> bool:
    """
    True only if the operator has a callback whose remind_at is due
    now or within the lookahead window AND the gate is effectively
    active for this operator (global switch + per-op opt-in).

    Future callbacks («перезвонить после обеда») don't block morning
    RR intake regardless of flag state.
    """
    if not _gate_active_for_operator(operator):
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
    if not _gate_active_for_operator(operator):
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
        LeadStatusLabel.objects.filter(is_active=True, blocks_new_leads=True).values_list(
            "code", flat=True
        )
    )


def terminal_lead_status_codes() -> list[str]:
    """
    Terminal codes — lead is done. Excluded from batch quota, /my active
    tab, and RR gate.
    """
    from .models import LeadStatusLabel

    return list(
        LeadStatusLabel.objects.filter(is_active=True, is_terminal=True).values_list(
            "code", flat=True
        )
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
        LeadStatusLabel.objects.filter(is_active=True, carry_over_next_day=True).values_list(
            "code", flat=True
        )
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
        LeadStatusLabel.objects.filter(is_active=True, recall_after_lunch=True).values_list(
            "code", flat=True
        )
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
        c for c in active if c not in carry and c not in recall and c not in UNTOUCHED_LEAD_STATUSES
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
    Count of «сегодня-плеч» оператора — активных лидов, за которые он
    отвечает СЕГОДНЯ и которые занимают его квоту RR.

    Правило (2026-08-04 обновление):
      lead in count ↔
        status in active_lead_status_codes() minus terminal minus carry
        AND postponed_at IS NULL
        AND (status in {new, assigned} OR updated_at < today_start
             OR (после 13:00 AND status in recall_codes AND
                 updated_at < lunch_start))

    Ключевое отличие от предыдущей версии: **carry-статусы (no_answer,
    no_answer_2, phone_on, callback_scheduled, contacted_telegram,
    dokonga_keladi) НЕ входят в квоту**. Они хранятся у оператора как
    отдельный хвост, всплывают завтра — но не блокируют refill сегодня.

    Раньше при большом carry-хвосте (30+ лидов) working_count всегда
    оставался >= RR_BATCH_SIZE, refill никогда не срабатывал → оператор
    сидел без новых свежих лидов, ставил ещё carry, цикл замыкался.
    Теперь: у каждого активного оператора всегда до RR_BATCH_SIZE (5)
    non-carry сегодняшних лидов + N carry-хвоста рядом.

    Recall-after-lunch-статусы (no_answer / phone_on) технически carry,
    но intraday-life у них есть: `_active_today_filter` умеет их
    возвращать после 13:00. Здесь мы всё равно их исключаем, потому что:
      1. `blocks_new_leads`-логика в бизнесе просит НЕ считать carry в квоту.
      2. Если оператор до обеда получил 5 свежих и все ушли в recall —
         после 13:00 refill выдаст ещё 5 (уже не блокирован), и оператор
         сможет параллельно добить утренние + новые. Это ожидаемое
         поведение (5 non-carry всегда + carry-хвост поверх).

    Powers the batch=N gate: while this count >= N, RR skips the operator.
    """
    return operator_quota_blocking_leads(operator).count()


def operator_quota_blocking_leads(operator: Operator) -> QuerySet[Lead]:
    """
    QuerySet лидов, которые прямо сейчас занимают квоту оператора —
    ровно те, что считает `operator_working_lead_count`. Старейшие
    первыми (их закрытие даёт максимальный эффект). Используется
    endpoint'ом `/leads/my/?quota=1`: оператор по подсказке «Показать
    какие закрыть» видит ТОЛЬКО этот список, без carry-хвоста.
    """
    terminal = set(terminal_lead_status_codes())
    carry = set(carry_over_status_codes())
    workable = list(set(active_lead_status_codes()) - terminal - carry)
    if not workable:
        return Lead.objects.none()
    return (
        Lead.objects.select_related("operator", "sheet_source")
        .filter(
            operator=operator,
            status__in=workable,
            postponed_at__isnull=True,
        )
        .filter(_active_today_filter())
        .order_by("updated_at")
    )


def _rr_batch_size() -> int:
    return int(getattr(settings, "RR_BATCH_SIZE", 5))


def my_status_for_operator(operator: Operator) -> dict:
    """
    Диагностика для страницы «Мои лиды» — сколько лидов на плечах, сколько
    из них carry-хвост (не в квоте), и куда идти оператору дальше.
    Отдаётся отдельным endpoint'ом, чтобы frontend мог показать понятный
    баннер + бейдж в sidebar одним запросом (react-query auto-dedup).

    Модель после 2026-08-04:
      - `working_count` = `operator_working_lead_count(op)` = **только
        сегодняшние non-carry в квоте** (макс. RR_BATCH_SIZE). Carry-лиды
        (no_answer, phone_on, callback_scheduled, contacted_telegram,
        dokonga_keladi, …) в квоту не входят и здесь не считаются.
      - `carry_count` — вчерашние carry-лиды (updated_at < today_start),
        которые оператор доработает завтра. Показываем отдельно как
        «хвост», не как блокер.
      - `recall_afternoon_count` — recall-статусы (no_answer, phone_on),
        тронутые сегодня до 13:00; после 13:00 всплывают снова и требуют
        повторного звонка. Возвращаем всегда, но `recall_active_now`
        подскажет фронту, показывать ли цифру.
      - `today_fresh_count` = working_count (алиас — все working сейчас
        сегодняшние по определению). Оставлен для обратной совместимости
        фронта, не переименовываем API-контракт без нужды.
      - `postponed_count` — отложенные оператором лиды, отдельный счётчик.
      - `eligible_for_new` = `working_count < quota_limit`.
      - `reason_ru` — готовая строка для баннера. Frontend обычно рендерит
        свои i18n-варианты по числам, но `reason_ru` — fallback.
    """
    from .models import Lead

    quota_limit = _rr_batch_size()
    working_count = operator_working_lead_count(operator)

    today_start = _today_start_local()
    now = timezone.localtime()
    lunch_start = _today_lunch_start()
    recall_active_now = now >= lunch_start

    carry_codes = carry_over_status_codes()
    recall_codes = recall_after_lunch_status_codes()

    terminal = set(terminal_lead_status_codes())
    all_non_terminal = list(set(active_lead_status_codes()) - terminal)

    # Carry-хвост: любой carry-статус у оператора, updated_at < today_start.
    # Считается ВНЕ working_count (working теперь исключает carry-статусы).
    # Postponed не учитываем — оператор явно попросил отложить, отдельная
    # секция `postponed_count`.
    carry_count = 0
    if carry_codes:
        carry_count = Lead.objects.filter(
            operator=operator,
            status__in=carry_codes,
            postponed_at__isnull=True,
            updated_at__lt=today_start,
        ).count()

    # Recall-after-lunch: сегодня утром поставил no_answer/phone_on, после
    # 13:00 надо перезвонить. Технически recall-коды ⊂ carry-коды (флаги
    # ортогональны на модели, но по seed данным пересекаются), поэтому
    # эти лиды тоже вне working_count. Их отдельно показываем оператору
    # чтобы он не забыл повторить контакт.
    recall_afternoon_count = 0
    if recall_active_now and recall_codes:
        recall_afternoon_count = Lead.objects.filter(
            operator=operator,
            status__in=recall_codes,
            postponed_at__isnull=True,
            updated_at__gte=today_start,
            updated_at__lt=lunch_start,
        ).count()

    # Все working сейчас non-carry сегодняшние — carry убран из квоты,
    # а recall (когда viсит в active-today) — это только non-carry-recall,
    # но recall-коды пересекаются с carry по seed'у, так что 0.
    # Оставляем поле для API-контракта (фронт его читает).
    today_fresh_count = working_count

    postponed_count = Lead.objects.filter(
        operator=operator,
        status__in=all_non_terminal,
        postponed_at__isnull=False,
    ).count()

    eligible_for_new = working_count < quota_limit

    # Русский текст для баннера — нейтральный тон, никаких «закрой чтобы
    # получить». Carry больше НЕ блокирует новых → баннер стал info/success.
    free = max(0, quota_limit - working_count)
    if working_count == 0 and carry_count == 0 and recall_afternoon_count == 0:
        reason_ru = "Свободно все слоты. Новые придут автоматически."
    elif carry_count > 0 and recall_afternoon_count > 0:
        reason_ru = (
            f"В работе {working_count} из {quota_limit}. Отдельно: "
            f"{carry_count} — вчерашние спец-лиды, "
            f"{recall_afternoon_count} — надо перезвонить после обеда."
        )
    elif carry_count > 0 and working_count < quota_limit:
        reason_ru = (
            f"В работе {working_count} из {quota_limit} + {carry_count} "
            "carry-хвост на завтра. Свободно "
            f"{free} слот{'ов' if free != 1 else ''}. Новые придут автоматически."
        )
    elif carry_count > 0:
        reason_ru = (
            f"Все {quota_limit} слотов в работе + {carry_count} "
            "carry-хвост на завтра. Закрой любой сегодняшний — придёт новый."
        )
    elif recall_afternoon_count > 0:
        reason_ru = (
            f"В работе {working_count} из {quota_limit}. "
            f"{recall_afternoon_count} — надо перезвонить после обеда."
        )
    elif working_count >= quota_limit:
        reason_ru = f"Все {quota_limit} слотов в работе. Закрой любой — придёт новый."
    else:
        reason_ru = f"Свободно {free} из {quota_limit} слотов. Новые придут автоматически."

    # Общая разбивка «сколько лидов у оператора в каждом статусе за всё время»
    # — нужна фронту для бейджей на chip-фильтрах. Chip показывает и terminal
    # статусы (contacted_telegram, harid_qildi, …), которые оператору иначе
    # никогда не покажутся в view=active — поэтому раньше count был 0 и
    # оператор не жал на chip, думая что там пусто.
    #
    # Считаем одним запросом через values+annotate, чтобы не плодить N SELECT'ов
    # по числу статусов. Возвращаем плоский dict {status_code: count} — фронту
    # удобнее чем список. postponed / carry / recall остаются отдельными
    # полями, здесь чистый разрез по status без времени/postponed_at.
    by_status_qs = Lead.objects.filter(operator=operator).values("status").annotate(n=Count("id"))
    by_status = {row["status"]: row["n"] for row in by_status_qs}
    total_leads = sum(by_status.values())

    # -------- Per-operator gate block --------------------------------
    # Показать оператору **конкретный список** лидов, которые его
    # блокируют — без этого он видит красный банер и не понимает «что
    # именно закрыть». Фронт рендерит карточки со ссылкой на лид.
    #
    # Список пустой, если гейт неактивен для оператора → фронт не
    # покажет блокировочный блок (баннер прячется автоматически).
    gate_active = _gate_active_for_operator(operator)
    global_gate_on = _morning_gate_enabled()
    op_gate_flag = bool(getattr(operator, "blocking_gate_enabled", False))

    blocking_leads: list[dict] = []
    overdue_callbacks: list[dict] = []
    if gate_active:
        # Спец-лиды (status с blocks_new_leads=True минус callback_scheduled
        # — колбэки идут отдельным списком overdue_callbacks). Отдаём
        # компактный shape: фронту нужно только имя, телефон, статус и id
        # для deep-link'а на карточку лида.
        codes = [c for c in blocking_lead_status_codes() if c != "callback_scheduled"]
        if codes:
            blk_qs = (
                Lead.objects.filter(operator=operator, status__in=codes)
                .order_by("updated_at")
                .values("id", "full_name", "phone", "status", "updated_at")[:50]
            )
            blocking_leads = [
                {
                    "id": r["id"],
                    "full_name": r["full_name"],
                    "phone": r["phone"],
                    "status": r["status"],
                    "updated_at": r["updated_at"].isoformat()
                    if r["updated_at"]
                    else None,
                }
                for r in blk_qs
            ]

        # Просроченные / скоро-due callback'и. Тот же lookahead-cutoff,
        # что использует `operator_has_open_callbacks` — оператор увидит
        # ровно тот список, что вызывает блокировку RR.
        from apps.calls.models import CallbackReminder, CallbackReminderStatus

        cb_cutoff = _callback_due_cutoff()
        cb_qs = (
            CallbackReminder.objects.select_related("lead")
            .filter(
                operator=operator,
                status__in=(
                    CallbackReminderStatus.PENDING,
                    CallbackReminderStatus.OVERDUE,
                    CallbackReminderStatus.SNOOZED,
                ),
                remind_at__lte=cb_cutoff,
            )
            .order_by("remind_at")[:50]
        )
        overdue_callbacks = [
            {
                "id": cb.id,
                "lead_id": cb.lead_id,
                "full_name": cb.lead.full_name if cb.lead else "",
                "phone": cb.lead.phone if cb.lead else "",
                "remind_at": cb.remind_at.isoformat() if cb.remind_at else None,
                "status": cb.status,
            }
            for cb in cb_qs
        ]

    return {
        "working_count": working_count,
        "quota_limit": quota_limit,
        "carry_count": carry_count,
        "recall_afternoon_count": recall_afternoon_count,
        "today_fresh_count": today_fresh_count,
        "postponed_count": postponed_count,
        "eligible_for_new": eligible_for_new,
        "reason_ru": reason_ru,
        "recall_active_now": recall_active_now,
        "by_status": by_status,
        "total_leads": total_leads,
        # Gate diagnostics — фронт использует их для рендера
        # «карточки-инструкции» вместо старого красного sticky banner.
        "gate_active": gate_active,
        "global_gate_on": global_gate_on,
        "operator_gate_flag": op_gate_flag,
        "blocking_leads": blocking_leads,
        "overdue_callbacks": overdue_callbacks,
        "blocking_leads_count": len(blocking_leads),
        "overdue_callbacks_count": len(overdue_callbacks),
    }


def operator_yesterday_backlog_count(operator: Operator) -> int:
    """
    Count of leads holding the operator: any lead in a
    manager-flagged «blocking» status. Time-independent — a phone_on
    lead marked five minutes ago still counts, because that phone
    conversation isn't done. Feeds the /my lock overlay.

    Returns 0 when the gate is not effectively active for this
    operator (global switch off OR per-op opt-in off) — то есть даже
    если у оператора есть спец-лиды, счётчик 0 и баннер не появится.
    """
    if not _gate_active_for_operator(operator):
        return 0
    # Same rule as operators_eligible_for_new_leads: callback_scheduled
    # is counted only when the reminder is due (via operator_open_callbacks_count).
    codes = [c for c in blocking_lead_status_codes() if c != "callback_scheduled"]
    if not codes:
        return 0
    return Lead.objects.filter(operator=operator, status__in=codes).count()


def operator_has_open_backlog(operator: Operator) -> bool:
    """Union check used by morning gate: open callback OR blocking status."""
    return operator_has_open_callbacks(operator) or operator_yesterday_backlog_count(operator) > 0


def operators_eligible_for_new_leads(*, bypass_gate: bool = False) -> QuerySet[Operator]:
    """
    Active operators eligible for round-robin.

    Batch quota: an operator holding >= RR_BATCH_SIZE working leads
    (active, non-terminal, non-postponed, **и ещё не тронутых сегодня**)
    is skipped — они добивают текущую «сегодня-пачку» до того, как RR
    подкинет следующую. Как только оператор сегодня закрыл/обработал
    все свои лиды, _working_count падает до 0 и он снова становится
    eligible → приходит новая пачка.

    When the morning gate is enabled (default: on via SystemSetting;
    overridable by settings.MORNING_GATE_ENABLED), additionally excludes
    anyone with a due callback or a blocking-status lead (spec-leads
    gate — «пока не разобрал спец-лиды, новых не получишь»).

    `bypass_gate=True` — для hot-sheets (is_hot=True). Отключает
    morning_gate И batch cap: горячий лид должен уйти оператору
    сразу, даже если он уперся в 5/5 или сидит с заблокированным
    спец-лидом. Используется в `next_operator_for_round_robin` когда
    `sheet_source.is_hot=True`.
    """
    from django.db.models import Count, Q

    terminal = set(terminal_lead_status_codes())
    carry = set(carry_over_status_codes())
    workable = list(set(active_lead_status_codes()) - terminal - carry)
    batch = _rr_batch_size()
    active_today = _leads_active_today_filter()

    from .availability import operators_available_for_auto_leads

    # Active, not paused and on shift right now — also for hot sheets:
    # `bypass_gate` lifts only the batch cap and the morning gate.
    qs = (
        operators_available_for_auto_leads()
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
        .order_by("id")
    )
    if not bypass_gate:
        qs = qs.filter(_working_count__lt=batch)

    if bypass_gate or not _morning_gate_enabled():
        return qs

    # Per-operator opt-in: гейт применяется ТОЛЬКО к операторам с
    # `blocking_gate_enabled=True`. Все остальные получают лидов
    # без блокировки, даже если у них есть спец-лиды или просроченный
    # callback. Это позволяет обкатать блокировку на выборке
    # (demo/тестовые), не выключая её глобально для всех.
    gate_op_ids = set(
        Operator.objects.filter(
            status=OperatorStatus.ACTIVE,
            blocking_gate_enabled=True,
        ).values_list("id", flat=True)
    )
    if not gate_op_ids:
        # Никого с включённым гейтом → нечего исключать.
        return qs

    from apps.calls.models import CallbackReminder, CallbackReminderStatus

    cb_blocked = set(
        CallbackReminder.objects.filter(
            operator_id__in=gate_op_ids,
            status__in=(
                CallbackReminderStatus.PENDING,
                CallbackReminderStatus.OVERDUE,
                CallbackReminderStatus.SNOOZED,
            ),
            remind_at__lte=_callback_due_cutoff(),
        ).values_list("operator_id", flat=True)
    )

    # Blocking-status exclusion (spec-leads gate). `callback_scheduled`
    # обрабатывается через CallbackReminder выше — иначе оператор
    # блокировался бы двойным механизмом и до срока callback'а.
    # Остальные (no_answer, phone_on, has_debt + manager-flagged) —
    # блокируют пока не сменят статус.
    codes = [c for c in blocking_lead_status_codes() if c != "callback_scheduled"]
    backlog_blocked: set[int] = set()
    if codes:
        backlog_blocked = set(
            Lead.objects.filter(
                operator_id__in=gate_op_ids,
                status__in=codes,
            ).values_list("operator_id", flat=True)
        )
    return qs.exclude(pk__in=(cb_blocked | backlog_blocked))


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
    carry = set(carry_over_status_codes())
    workable = list(set(active_lead_status_codes()) - terminal - carry)
    # `_postponed_count` включает carry-в-postponed, ок — postponed
    # дизъюнктен с working (у working NOT NULL исключён).
    all_non_terminal = list(set(active_lead_status_codes()) - terminal)
    active_today = _leads_active_today_filter()

    ops = list(
        Operator.objects.filter(status=OperatorStatus.ACTIVE)
        .annotate(
            # «сегодня-плечи»: активные (не carry), не отложенные,
            # не тронутые сегодня. Carry-хвост исключён — он больше
            # не блокирует квоту (см. `operator_working_lead_count`).
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
                    leads__status__in=all_non_terminal,
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
        if getattr(op, "is_paused", False):
            reasons.append("Оператор на паузе (новых лидов не получает)")
        if working >= batch:
            reasons.append(f"Квота: {working}/{batch} — освободите слот, закрыв лид")
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


def next_operator_for_round_robin(
    *, sheet_source: SheetSource | None = None,
) -> Operator | None:
    """
    Deterministic-ish round-robin: pick the eligible operator with the
    fewest *currently active* leads. Ties broken by lowest id (stable).

    Если передан `sheet_source` и у него настроен пер-шитовый пул
    (`allowed_operators`) — кандидаты пересекаются с этим списком. Пустой
    пул означает «раздача всем активным» и НЕ должен превращаться в
    «никто».

    Если `sheet_source.is_hot=True` — RR обходит morning_gate и batch cap
    (горячий лид доходит до оператора даже с заблокированным спец-лидом
    или полной 5/5 пачкой — ТЕЗ10 SLA важнее).
    """
    bypass = bool(sheet_source and getattr(sheet_source, "is_hot", False))
    qs = operators_eligible_for_new_leads(bypass_gate=bypass).annotate(
        active_leads_count=Count(
            "leads",
            filter=Q(leads__status__in=active_lead_status_codes()),
        )
    )
    if sheet_source is not None:
        allowed_ids = list(
            sheet_source.allowed_operators.values_list("id", flat=True)
        )
        if allowed_ids:
            qs = qs.filter(id__in=allowed_ids)
    return qs.order_by("active_leads_count", "id").first()


# ---- Sheet configuration --------------------------------------------------


def alias_lookup(alias_name: str) -> OperatorSheetAlias | None:
    if not alias_name:
        return None
    return OperatorSheetAlias.objects.filter(alias_name__iexact=alias_name.strip()).first()


# ---- Retry-export candidates ---------------------------------------------
#
# Список статусов для retry-export'а раньше был захардкожен здесь.
# Начиная с 2026-09-03 он живёт в SystemSetting.retry_export_statuses и
# редактируется менеджером через /leads-stats → «Retry статусы».
#
# `RETRY_EXPORT_STATUSES` оставлен как **алиас на дефолт** —
# исторический шум в тестах и импорты (`from apps.leads.selectors import
# RETRY_EXPORT_STATUSES`) продолжают работать: константа означает
# «дефолтный fallback», а не «текущий выбор менеджера».

from apps.system_settings.selectors import (  # noqa: E402
    DEFAULT_RETRY_EXPORT_STATUSES as _DEFAULT_RETRY_EXPORT_STATUSES,
    get_retry_export_statuses as _get_retry_export_statuses,
)

# Backwards-compat alias: старые импорты (внешние скрипты, тесты)
# продолжают ссылаться на этот tuple. Значение = дефолтный набор
# ретрай-статусов (SMS+TG+2×no_answer).
RETRY_EXPORT_STATUSES: tuple[str, ...] = _DEFAULT_RETRY_EXPORT_STATUSES


def retry_export_candidates() -> QuerySet[Lead]:
    """
    Все лиды в статусах, выбранных менеджером в SystemSetting.retry_export_statuses.

    Если менеджер ещё не сохранил свой набор — используется дефолт
    (sms_jonatildi, contacted_telegram, no_answer, no_answer_2).

    Порядок — `-updated_at`, чтобы менеджер в свежесозданном tab'е
    видел последние по времени смены статуса сверху.
    """
    codes = _get_retry_export_statuses()
    return (
        Lead.objects
        .filter(status__in=codes)
        .select_related("operator", "sheet_source")
        .order_by("-updated_at")
    )


# ---- Telegram link cache --------------------------------------------------


def telegram_link_for_phone(phone: str) -> TelegramLink | None:
    if not phone:
        return None
    return TelegramLink.objects.filter(phone=phone).first()


# ---- Auto-assignment diagnostics -----------------------------------------
#
# Ниже — публичная поверхность «почему у оператора X сейчас нет автораздачи».
# Логика — приоритетный чек-лист, вплоть до момента, когда конкретное
# правило блокирует refill (или, наоборот, всё зелёное и вопрос в чём-то
# другом). Отдаёт машинно-читаемый dict, чтобы:
#   1. Bot-хендлер /whyauto собрал из него человеческий текст.
#   2. API мог рендерить менеджерскую таблицу без дополнительного parsing'а.
#
# Порядок проверки соответствует реальному code path'у в
# `operators_eligible_for_new_leads()` + `refill_operator_leads()`, чтобы
# «первая красная лампочка» всегда была той же, которую увидит raise-fail
# в runtime.


AUTO_DIAG_REASON_ORDER = (
    # High-level global switches — если выключено, ничего не поедет никому.
    "auto_distribution_disabled",
    "empty_pool",
    # Per-operator: сначала статус, потом квота, потом gate.
    "operator_not_active",
    "operator_paused",
    "quota_full",
    "morning_gate_backlog",
    "morning_gate_callback",
    # Всё зелёное — но за N минут refill не работал.
    "healthy_but_idle",
    "healthy",
)


def _lookup_leads_recent_source_counts(operator: Operator, hours: int = 24) -> dict:
    """
    За последние `hours` часов: сколько лидов пришло оператору каждым
    из источников (`morning_split` / `auto_refill` / `auto_round_robin` /
    `admin_reassign` / `qimmatlik_retry`). Пустой dict → оператор ничего
    не получал за окно.
    """
    from apps.leads.models import LeadAssignment

    cutoff = timezone.now() - dt.timedelta(hours=hours)
    rows = (
        LeadAssignment.objects.filter(operator=operator, created_at__gte=cutoff)
        .values("source")
        .annotate(n=Count("id"))
    )
    return {r["source"]: r["n"] for r in rows}


def _orphan_pool_size() -> int:
    """
    Текущий размер общего пула сирот, из которого refill/morning_distribute
    достают лидов. 0 → доливать нечего, никаких претензий к
    per-operator логике нет.
    """
    active = active_lead_status_codes()
    terminal = set(terminal_lead_status_codes())
    workable = [c for c in active if c not in terminal]
    if not workable:
        return 0
    return Lead.objects.filter(
        operator__isnull=True,
        status__in=workable,
        phone_invalid=False,
        needs_review=False,
    ).count()


def operator_yesterday_unclosed_count(operator: Operator) -> int:
    """
    Количество лидов у оператора, которые были назначены/обновлены
    до сегодняшнего дня (updated_at < today_start) и всё ещё не
    закрыты (статус НЕ в terminal_lead_status_codes).
    """
    today_start = _today_start_local()
    terminal = set(terminal_lead_status_codes())
    return Lead.objects.exclude(status__in=terminal).filter(
        operator=operator, updated_at__lt=today_start
    ).count()


def operator_yesterday_unclosed_leads(operator: Operator, limit: int = 50) -> list[dict]:
    """
    Список незакрытых лидов с прошлых дней для оператора.
    Старейшие первыми — чтобы менеджер мог показать оператору
    «вот твои 7 вчерашних лидов, закрой их».
    """
    from apps.leads.models import LeadStatusLabel

    today_start = _today_start_local()
    terminal = set(terminal_lead_status_codes())
    now = timezone.localtime()
    labels = {
        l.code: {"ru": l.label_ru, "uz": l.label_uz or l.label_ru}
        for l in LeadStatusLabel.objects.all()
    }

    leads = (
        Lead.objects.exclude(status__in=terminal)
        .filter(operator=operator, updated_at__lt=today_start)
        .order_by("updated_at")[:limit]
        .values("id", "full_name", "phone", "status", "updated_at", "created_at")
    )
    result: list[dict] = []
    for r in leads:
        lbl = labels.get(r["status"], {"ru": r["status"], "uz": r["status"]})
        upd = r["updated_at"]
        days = int((now - upd).total_seconds() // 86400) if upd else 1
        result.append(
            {
                "id": r["id"],
                "full_name": r["full_name"],
                "phone": r["phone"],
                "status": r["status"],
                "status_label_ru": lbl["ru"],
                "status_label_uz": lbl["uz"],
                "updated_at": upd.isoformat() if upd else None,
                "created_at": r["created_at"].isoformat() if r["created_at"] else None,
                "days_ago": max(1, days),
            }
        )
    return result


def diagnose_operator_assignment(operator: Operator) -> dict:
    """
    «Почему у оператора нет / есть автораздача прямо сейчас?»

    Возвращает приоритетный вердикт + диагностические цифры. Порядок
    проверок соответствует boiled-down code path:
      1. Глобальный killswitch `auto_distribution_enabled`.
      2. Оператор не ACTIVE (уволен / стажёр в инактиве).
      3. Оператор на паузе (`is_paused=True`).
      4. Пустой пул сирот — доливать нечего никому.
      5. Квота: `working_count >= RR_BATCH_SIZE`.
      6. Morning gate — просроченный callback (если effective для op).
      7. Morning gate — блокирующие статусы (если effective для op).
      8. healthy_but_idle: всё ок, но за последние 24ч авто-раздача
         не давала ничего.
      9. healthy: всё зелёное, недавно приходили лиды.
    """
    from apps.system_settings.selectors import auto_distribution_enabled

    quota = _rr_batch_size()
    working = operator_working_lead_count(operator)
    op_gate_flag = bool(getattr(operator, "blocking_gate_enabled", False))
    global_gate = _morning_gate_enabled()
    gate_active = _gate_active_for_operator(operator)
    pool_size = _orphan_pool_size()
    recent_assignments = _lookup_leads_recent_source_counts(operator, hours=24)
    now = timezone.now()
    yesterday_unclosed = operator_yesterday_unclosed_count(operator)
    is_paused = bool(getattr(operator, "is_paused", False))

    terminal = set(terminal_lead_status_codes())
    carry = set(carry_over_status_codes())
    all_active = set(active_lead_status_codes())
    workable_codes = list(all_active - terminal - carry)
    blocking_leads: list[dict] = []
    if workable_codes:
        blk = (
            Lead.objects.filter(
                operator=operator,
                status__in=workable_codes,
                postponed_at__isnull=True,
            )
            .filter(_active_today_filter())
            .order_by("updated_at")
            .values("id", "full_name", "phone", "status", "updated_at")[:5]
        )
        blocking_leads = [
            {
                "id": r["id"],
                "full_name": r["full_name"],
                "phone": r["phone"],
                "status": r["status"],
                "updated_at": r["updated_at"].isoformat() if r["updated_at"] else None,
            }
            for r in blk
        ]

    yesterday_sample = operator_yesterday_unclosed_leads(operator, limit=10)

    counters = {
        "working": working,
        "quota": quota,
        "pool_size": pool_size,
        "backlog_blocking_leads": operator_yesterday_backlog_count(operator),
        "yesterday_unclosed_leads": yesterday_unclosed,
        "open_callbacks": operator_open_callbacks_count(operator),
        "global_gate_on": global_gate,
        "operator_gate_flag": op_gate_flag,
        "gate_active": gate_active,
        "is_paused": is_paused,
    }
    op_payload = {
        "id": operator.id,
        "full_name": operator.full_name,
        "status": operator.status,
        "blocking_gate_enabled": op_gate_flag,
        "is_paused": is_paused,
    }

    # -------------- 1. Global killswitch ----------------------------------
    if not auto_distribution_enabled():
        return {
            "operator": op_payload,
            "verdict": "auto_distribution_disabled",
            "verdict_title_ru": "Автораздача выключена глобально",
            "verdict_body_ru": (
                "Менеджер выключил тумблер «Автораздача» в /settings/distribution/. "
                "Пока он включён обратно, ни morning-split, ни refill не работают "
                "ни для кого — это не индивидуально."
            ),
            "next_action_ru": "Включи автораздачу в /settings/distribution/.",
            "counters": counters,
            "recent_assignments": recent_assignments,
            "blocking_leads": blocking_leads,
            "yesterday_leads": yesterday_sample,
        }

    # -------------- 2. Operator not ACTIVE -------------------------------
    if operator.status != OperatorStatus.ACTIVE:
        return {
            "operator": op_payload,
            "verdict": "operator_not_active",
            "verdict_title_ru": "Оператор не активен",
            "verdict_body_ru": (
                f"Статус оператора: {operator.status}. Автораздача работает "
                "только для операторов со статусом «active»."
            ),
            "next_action_ru": (
                "Переведи оператора в active в /operators/, если он снова "
                "на смене."
            ),
            "counters": counters,
            "recent_assignments": recent_assignments,
            "blocking_leads": blocking_leads,
            "yesterday_leads": yesterday_sample,
        }

    # -------------- 3. Operator on pause ---------------------------------
    if is_paused:
        return {
            "operator": op_payload,
            "verdict": "operator_paused",
            "verdict_title_ru": "Оператор на паузе",
            "verdict_body_ru": (
                "Оператор временно поставлен на паузу (is_paused=True). "
                "Пока пауза не снята, автораздача не выдаёт ему новых лидов."
            ),
            "next_action_ru": (
                "Сними паузу в карточке оператора (кнопка «Снять с паузы»)."
            ),
            "counters": counters,
            "recent_assignments": recent_assignments,
            "blocking_leads": blocking_leads,
            "yesterday_leads": yesterday_sample,
        }

    # -------------- 4. Empty pool ----------------------------------------
    if pool_size == 0 and working < quota:
        return {
            "operator": op_payload,
            "verdict": "empty_pool",
            "verdict_title_ru": "Пул свободных лидов пуст",
            "verdict_body_ru": (
                f"У оператора свободно {quota - working} слот(ов) из {quota}, "
                "но в общем пуле нет ни одного unassigned-лида. "
                "Как только sheet-sync подъедет новые (обычно ~5 минут) — "
                "watcher доложит по 5 штук каждому."
            ),
            "next_action_ru": (
                "Дождись следующего sheet-sync или проверь Google Sheets — "
                "возможно, новых заявок сегодня физически меньше."
            ),
            "counters": counters,
            "recent_assignments": recent_assignments,
            "blocking_leads": blocking_leads,
            "yesterday_leads": yesterday_sample,
        }

    # -------------- 4. Quota full ----------------------------------------
    if working >= quota:
        stale_hours = 0
        if blocking_leads and blocking_leads[0]["updated_at"]:
            try:
                oldest = dt.datetime.fromisoformat(blocking_leads[0]["updated_at"])
                stale_hours = int((now - oldest).total_seconds() // 3600)
            except Exception:
                pass
        return {
            "operator": op_payload,
            "verdict": "quota_full",
            "verdict_title_ru": (
                f"Квота {working}/{quota} — оператор не разгребает старые лиды"
            ),
            "verdict_body_ru": (
                f"У оператора на плечах {working} активных сегодняшних лидов "
                f"(лимит {quota}). Пока working_count не упадёт ниже {quota}, "
                "watcher и round-robin его пропускают. "
                f"Самый старый лид в очереди висит уже ≈ {stale_hours}ч."
            ),
            "next_action_ru": (
                f"Оператору нужно закрыть минимум {max(working - quota + 1, 1)} "
                "лидов (WON / LOST / нужный статус). Как только квота "
                f"освободится — watcher добьёт до {quota} автоматически."
            ),
            "counters": counters,
            "recent_assignments": recent_assignments,
            "blocking_leads": blocking_leads,
            "yesterday_leads": yesterday_sample,
        }

    # -------------- 5-6. Morning gate ------------------------------------
    # Callback приоритетнее backlog (совпадает с логикой RR-фильтра).
    if gate_active and operator_has_open_callbacks(operator):
        return {
            "operator": op_payload,
            "verdict": "morning_gate_callback",
            "verdict_title_ru": "Morning-gate: просроченный callback",
            "verdict_body_ru": (
                f"У оператора {counters['open_callbacks']} callback'ов с "
                "истёкшим или близким сроком. Гейт включён для этого "
                "оператора (per-op flag ON) — пока callback не закрыт, "
                "новых лидов ему не дают."
            ),
            "next_action_ru": (
                "Пусть оператор позвонит / перенесёт callback. Как только "
                "статус закрыт — watcher подхватит."
            ),
            "counters": counters,
            "recent_assignments": recent_assignments,
            "blocking_leads": blocking_leads,
            "yesterday_leads": yesterday_sample,
        }
    if gate_active and counters["backlog_blocking_leads"] > 0:
        return {
            "operator": op_payload,
            "verdict": "morning_gate_backlog",
            "verdict_title_ru": "Morning-gate: спец-лид на плечах",
            "verdict_body_ru": (
                f"У оператора {counters['backlog_blocking_leads']} лид(ов) "
                "в блокирующих статусах (has_debt / no_answer / phone_on / "
                "dokonga_keladi / …). Гейт включён (per-op flag ON) — "
                "новых лидов не пускает."
            ),
            "next_action_ru": (
                "Пусть оператор переведёт спец-лиды в терминальный статус, "
                "либо выключи `blocking_gate_enabled` в UI оператора."
            ),
            "counters": counters,
            "recent_assignments": recent_assignments,
            "blocking_leads": blocking_leads,
            "yesterday_leads": yesterday_sample,
        }

    # -------------- 7. Healthy but idle ----------------------------------
    auto_sources = {"auto_refill", "auto_round_robin", "morning_split", "qimmatlik_retry"}
    auto_recent = sum(v for k, v in recent_assignments.items() if k in auto_sources)
    if auto_recent == 0:
        return {
            "operator": op_payload,
            "verdict": "healthy_but_idle",
            "verdict_title_ru": "Всё зелёное, но за 24ч авто-лидов не было",
            "verdict_body_ru": (
                "Гейт не блокирует, квота свободна, автораздача включена. "
                "Но за последние 24ч ни один лид не пришёл этому оператору "
                "автоматически. Скорее всего пул подсыхал или sheet-sync не "
                "приносил новых заявок. Проверь размер пула — сейчас "
                f"{pool_size} свободных лидов."
            ),
            "next_action_ru": (
                "Если пул > 0 — жди 1-2 минуты, distribute-watcher разложит. "
                "Если пул = 0 — проблема на входе (Google Sheets), не в раздаче."
            ),
            "counters": counters,
            "recent_assignments": recent_assignments,
            "blocking_leads": blocking_leads,
            "yesterday_leads": yesterday_sample,
        }

    # -------------- 8. Healthy -------------------------------------------
    return {
        "operator": op_payload,
        "verdict": "healthy",
        "verdict_title_ru": "Автораздача работает нормально",
        "verdict_body_ru": (
            f"За последние 24ч оператору автоматически пришло "
            f"{auto_recent} лид(ов) (по источникам: "
            + ", ".join(f"{k}={v}" for k, v in recent_assignments.items() if k in auto_sources)
            + f"). Квота {working}/{quota}, пул {pool_size}, гейт неактивен для этого оператора. "
            "Жалоба, вероятно, про количество: сегодня заявок физически меньше."
        ),
        "next_action_ru": (
            "Если кажется, что «мало» — сравни с прошлыми днями в "
            "/analytics или проверь, не отключился ли один из sheet-source'ов."
        ),
        "counters": counters,
        "recent_assignments": recent_assignments,
        "blocking_leads": blocking_leads,
        "yesterday_leads": yesterday_sample,
    }


_CYR_TO_LAT = {
    "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ё": "yo",
    "ж": "j", "з": "z", "и": "i", "й": "y", "к": "k", "л": "l", "м": "m",
    "н": "n", "о": "o", "п": "p", "р": "r", "с": "s", "т": "t", "у": "u",
    "ф": "f", "х": "x", "ц": "ts", "ч": "ch", "ш": "sh", "щ": "sh",
    "ъ": "", "ы": "i", "ь": "", "э": "e", "ю": "yu", "я": "ya",
    "ғ": "g", "қ": "q", "ў": "o", "ҳ": "x",
}


def _canon_name(text: str) -> str:
    """
    Каноническая форма имени для кросс-алфавитного матча
    («Мухлиса» == «Muxlisa» == «Muhlisa»). Обе стороны (запрос и
    full_name из БД) прогоняются через одну и ту же нормализацию,
    поэтому спорные пары x/h и q/k схлопываются в один символ.
    """
    out = "".join(_CYR_TO_LAT.get(ch, ch) for ch in text.lower())
    for src, dst in (("h", "x"), ("q", "k"), ("'", ""), ("ʼ", ""), ("`", "")):
        out = out.replace(src, dst)
    return out


def assignment_summary(target_date: dt.date | None = None) -> list[dict]:
    """
    Сводка «кто сколько получил лидов за день» для ops-агента бота.

    За указанный день (по умолчанию — сегодня в Asia/Tashkent) собираем
    количество новых `LeadAssignment` по каждому оператору с разбивкой
    по source (`auto_refill` / `auto_round_robin` / `morning_split` /
    `admin_reassign` / `qimmatlik_retry` / `sheet_manual`), плюс текущий
    working_count/квоту из `operators_distribution_status()`.

    Возвращает список dict, отсортированный по total DESC:
      [
        {
          "operator_id": 33,
          "full_name": "Muxlisa",
          "status": "active",
          "total": 15,
          "by_source": {"morning_split": 10, "auto_refill": 5},
          "working_count": 5,   # None если оператор не ACTIVE
          "quota": 5,           # RR_BATCH_SIZE
          "eligible": False,    # None если не ACTIVE
        },
        ...
      ]

    Операторов, у которых 0 назначений за день И которые не ACTIVE,
    отдаём в конце — иначе бот будет засорять экран уволенными.
    """
    from apps.leads.models import LeadAssignment

    tz = timezone.get_current_timezone()
    day = target_date or timezone.localdate()
    start_local = dt.datetime.combine(day, dt.time.min, tzinfo=tz)
    end_local = start_local + dt.timedelta(days=1)

    rows = (
        LeadAssignment.objects.filter(
            created_at__gte=start_local,
            created_at__lt=end_local,
            operator__isnull=False,
        )
        .values("operator_id", "source")
        .annotate(n=Count("id"))
    )

    per_op: dict[int, dict] = {}
    for r in rows:
        entry = per_op.setdefault(
            r["operator_id"],
            {"total": 0, "by_source": {}},
        )
        entry["total"] += r["n"]
        entry["by_source"][r["source"]] = r["n"]

    # Тянем базовую инфу для всех операторов, которые фигурировали в раздачах
    # (могут быть INACTIVE — тогда working_count/eligible не считаем).
    op_ids = list(per_op.keys())
    op_map: dict[int, Operator] = {}
    if op_ids:
        op_map = {
            op.id: op
            for op in Operator.objects.filter(id__in=op_ids).only(
                "id", "full_name", "status"
            )
        }

    # Плюс — активные операторы БЕЗ назначений за день (чтобы менеджер
    # увидел «у Мухлисы 0 сегодня, а квота 5/5 забита»).
    status_rows = operators_distribution_status()
    status_by_id: dict[int, dict] = {r["id"]: r for r in status_rows}
    quota = _rr_batch_size()

    result: list[dict] = []
    seen: set[int] = set()

    for op_id, entry in per_op.items():
        op = op_map.get(op_id)
        st = status_by_id.get(op_id)
        result.append(
            {
                "operator_id": op_id,
                "full_name": op.full_name if op else f"?({op_id})",
                "status": op.status if op else "unknown",
                "total": entry["total"],
                "by_source": entry["by_source"],
                "working_count": st["working_count"] if st else None,
                "quota": quota,
                "eligible": st["eligible"] if st else None,
                "reason": st["reason"] if st else "",
            }
        )
        seen.add(op_id)

    # Активные операторы без назначений — добавляем с total=0, чтобы бот
    # мог показать «эти сегодня вообще ничего не получили».
    for st in status_rows:
        if st["id"] in seen:
            continue
        result.append(
            {
                "operator_id": st["id"],
                "full_name": st["full_name"],
                "status": st["status"],
                "total": 0,
                "by_source": {},
                "working_count": st["working_count"],
                "quota": quota,
                "eligible": st["eligible"],
                "reason": st["reason"],
            }
        )

    # Сортировка: total DESC, потом working_count ASC (свободные выше),
    # потом id ASC для стабильности.
    result.sort(
        key=lambda r: (
            -r["total"],
            r["working_count"] if r["working_count"] is not None else 999,
            r["operator_id"],
        )
    )
    return result


def operator_assignments_for_day(
    operator: Operator, target_date: dt.date | None = None
) -> list[dict]:
    """
    История выдач конкретному оператору за день — «почему ему дало 15».

    Возвращает список dict в хронологическом порядке (старейшие сверху):
      [
        {
          "assignment_id": 1234,
          "created_at": "2026-09-02T08:30:12+05:00",
          "source": "morning_split",
          "lead_id": 42,
          "lead_name": "Ali Valiyev",
          "lead_phone": "+998901234567",
          "lead_status": "assigned",
          "reason": "",
        },
        ...
      ]
    """
    from apps.leads.models import LeadAssignment

    tz = timezone.get_current_timezone()
    day = target_date or timezone.localdate()
    start_local = dt.datetime.combine(day, dt.time.min, tzinfo=tz)
    end_local = start_local + dt.timedelta(days=1)

    rows = (
        LeadAssignment.objects.filter(
            operator=operator,
            created_at__gte=start_local,
            created_at__lt=end_local,
        )
        .select_related("lead")
        .order_by("created_at")
    )
    result: list[dict] = []
    for row in rows:
        lead = row.lead
        result.append(
            {
                "assignment_id": row.id,
                "created_at": row.created_at.isoformat() if row.created_at else None,
                "source": row.source,
                "lead_id": lead.id if lead else None,
                "lead_name": (lead.full_name if lead else "") or "",
                "lead_phone": (lead.phone if lead else "") or "",
                "lead_status": (lead.status if lead else "") or "",
                "reason": row.reason or "",
            }
        )
    return result


def find_operators_by_freetext(query: str, *, limit: int = 5) -> list[Operator]:
    """
    Найти оператора(ов) по свободному тексту: имя, часть имени, id, phone.

    Используется ботом когда менеджер пишет «почему у Мухлисы нет
    автораздачи?» — парсер (в bot) выделяет слово, а этот селектор
    возвращает кандидатов. Матч регистронезависимый, кросс-алфавитный
    (кириллица ↔ узбекская латиница), включает инактивных (чтобы
    диагностика могла ответить «оператор уволен»).
    """
    q = (query or "").strip()
    if not q:
        return []
    qs = Operator.objects.all()
    # numeric id — точный матч побеждает
    if q.isdigit():
        by_id = qs.filter(pk=int(q))
        if by_id.exists():
            return list(by_id[:limit])
    # phone-like (цифры + плюс) → нормализуем и ищем по хвосту
    phone_digits = "".join(ch for ch in q if ch.isdigit())
    if len(phone_digits) >= 7:
        by_phone = qs.filter(phone__icontains=phone_digits[-9:])
        if by_phone.exists():
            return list(by_phone.order_by("id")[:limit])
    # текстовый матч: icontains по каждому слову
    words = [w for w in q.split() if len(w) >= 2]
    if not words:
        return []
    filtered = qs
    for w in words:
        filtered = filtered.filter(full_name__icontains=w)
    result = list(filtered.order_by("status", "id")[:limit])
    if result:
        return result
    # fallback: канонический кросс-алфавитный матч в Python
    # (операторов десятки, полный проход дешёвый)
    canon_words = [_canon_name(w) for w in words]
    matched = [
        op
        for op in qs.only("id", "full_name", "status", "phone")
        if all(w in _canon_name(op.full_name) for w in canon_words)
    ]
    matched.sort(key=lambda o: (o.status, o.id))
    return matched[:limit]


def operators_distribution_diagnostics(
    *,
    operator_id: int | None = None,
    filter_status: str | None = None,
    search: str | None = None,
) -> dict:
    """
    Комплексная диагностика автораздачи по всем операторам (и детально
    по выбранному operator_id).

    Даёт менеджеру мгновенный ответ на вопрос оператора «Почему мне не
    дают лидов?»:
      - оператор на паузе (is_paused=True)
      - квота заполнена (рабочих лидов >= RR_BATCH_SIZE)
      - вчерашние незакрытые лиды / спец-лиды (yesterday_unclosed_leads)
      - просроченный callback
      - нет отметки в табеле (AttendanceLog)
      - пустой пул сирот
      - глобальный killswitch выключен
    """
    from django.db.models import Max
    from apps.system_settings.selectors import auto_distribution_enabled
    from apps.leads.models import LeadAssignment, LeadStatusLabel, SheetSource
    from apps.calls.models import CallbackReminder, CallbackReminderStatus, CallAttempt
    from apps.attendance.models import AttendanceLog

    auto_on = auto_distribution_enabled()
    batch = _rr_batch_size()
    pool_size = _orphan_pool_size()
    morning_gate = _morning_gate_enabled()
    today_start = _today_start_local()
    now = timezone.localtime()

    terminal_codes = set(terminal_lead_status_codes())
    carry_codes = set(carry_over_status_codes())
    workable_codes = list(set(active_lead_status_codes()) - terminal_codes - carry_codes)
    all_non_terminal = list(set(active_lead_status_codes()) - terminal_codes)
    active_today = _leads_active_today_filter()
    labels = {
        l.code: {"ru": l.label_ru, "uz": l.label_uz or l.label_ru}
        for l in LeadStatusLabel.objects.all()
    }

    # Все операторы с аннотациями working и postponed
    qs = Operator.objects.all().annotate(
        _working_count=Count(
            "leads",
            filter=Q(
                leads__status__in=workable_codes,
                leads__postponed_at__isnull=True,
            )
            & active_today,
        ),
        _postponed_count=Count(
            "leads",
            filter=Q(
                leads__status__in=all_non_terminal,
                leads__postponed_at__isnull=False,
            ),
        ),
    )

    # Поиск если передан
    if search and search.strip():
        s = search.strip()
        matched_ops = find_operators_by_freetext(s, limit=100)
        matched_ids = [o.id for o in matched_ops]
        qs = qs.filter(id__in=matched_ids)

    ops = list(qs)
    op_ids = [o.id for o in ops]

    # Bulk агрегации
    unclosed_yesterday_map = dict(
        Lead.objects.exclude(status__in=terminal_codes)
        .filter(updated_at__lt=today_start, operator_id__in=op_ids)
        .values("operator_id")
        .annotate(c=Count("id"))
        .values_list("operator_id", "c")
    )

    carry_map = (
        dict(
            Lead.objects.filter(
                status__in=carry_codes,
                updated_at__lt=today_start,
                operator_id__in=op_ids,
                postponed_at__isnull=True,
            )
            .values("operator_id")
            .annotate(c=Count("id"))
            .values_list("operator_id", "c")
        )
        if carry_codes
        else {}
    )

    blocking_codes = [c for c in blocking_lead_status_codes() if c != "callback_scheduled"]
    blocking_map = (
        dict(
            Lead.objects.filter(status__in=blocking_codes, operator_id__in=op_ids)
            .values("operator_id")
            .annotate(c=Count("id"))
            .values_list("operator_id", "c")
        )
        if blocking_codes
        else {}
    )

    cb_cutoff = _callback_due_cutoff()
    callbacks_map = dict(
        CallbackReminder.objects.filter(
            status__in=(
                CallbackReminderStatus.PENDING,
                CallbackReminderStatus.OVERDUE,
                CallbackReminderStatus.SNOOZED,
            ),
            remind_at__lte=cb_cutoff,
            operator_id__in=op_ids,
        )
        .values("operator_id")
        .annotate(c=Count("id"))
        .values_list("operator_id", "c")
    )

    today_received_map = dict(
        LeadAssignment.objects.filter(
            created_at__gte=today_start,
            operator_id__in=op_ids,
        )
        .values("operator_id")
        .annotate(c=Count("id"))
        .values_list("operator_id", "c")
    )

    last_assigned_map = dict(
        LeadAssignment.objects.filter(operator_id__in=op_ids)
        .values("operator_id")
        .annotate(last_at=Max("created_at"))
        .values_list("operator_id", "last_at")
    )

    today_calls_map = dict(
        CallAttempt.objects.filter(
            created_at__gte=today_start,
            operator_id__in=op_ids,
        )
        .values("operator_id")
        .annotate(c=Count("id"))
        .values_list("operator_id", "c")
    )

    checked_in_set = set(
        AttendanceLog.objects.filter(
            checked_in_at__gte=today_start,
            operator_id__in=op_ids,
        ).values_list("operator_id", flat=True)
    )
    has_open_checkin_set = set(
        AttendanceLog.objects.filter(
            checked_in_at__gte=today_start,
            checked_out_at__isnull=True,
            operator_id__in=op_ids,
        ).values_list("operator_id", flat=True)
    )

    # SheetSource allowed_operators mapping
    sheet_sources = list(SheetSource.objects.filter(active=True).prefetch_related("allowed_operators"))
    allowed_sheets_map: dict[int, list[str]] = {}
    restricted_sheet_names: list[str] = []
    for ss in sheet_sources:
        allowed_ops = list(ss.allowed_operators.all())
        if allowed_ops:
            restricted_sheet_names.append(ss.name)
            for a_op in allowed_ops:
                allowed_sheets_map.setdefault(a_op.id, []).append(ss.name)

    operator_rows = []
    summary_counts = {
        "total_operators": len(ops),
        "eligible_count": 0,
        "blocked_count": 0,
        "paused_count": 0,
        "quota_full_count": 0,
        "yesterday_backlog_count": 0,
        "gate_blocked_count": 0,
        "not_checked_in_count": 0,
    }

    selected_op_obj = None

    for op in ops:
        if operator_id and op.id == operator_id:
            selected_op_obj = op

        working = op._working_count
        postponed = op._postponed_count
        is_paused = bool(getattr(op, "is_paused", False))
        is_active = (op.status == OperatorStatus.ACTIVE)
        gate_flag = bool(getattr(op, "blocking_gate_enabled", False))
        gate_effective = morning_gate and gate_flag
        req_checkin = bool(getattr(op, "require_checkin_enabled", False))

        unclosed_yd = unclosed_yesterday_map.get(op.id, 0)
        carry_c = carry_map.get(op.id, 0)
        open_cb = callbacks_map.get(op.id, 0)
        backlog_c = blocking_map.get(op.id, 0)
        today_recv = today_received_map.get(op.id, 0)
        today_calls = today_calls_map.get(op.id, 0)
        last_at = last_assigned_map.get(op.id)
        checked_in = (op.id in checked_in_set)
        open_shift = (op.id in has_open_checkin_set)

        blockers = []
        reasons_uz = []
        reasons_ru = []

        if not auto_on:
            blockers.append("auto_off")
            reasons_uz.append("Avtotizim o'chirilgan")
            reasons_ru.append("Автораздача выключена глобально")

        if not is_active:
            blockers.append("not_active")
            reasons_uz.append(f"Operator faol emas ({op.status})")
            reasons_ru.append(f"Оператор не активен ({op.status})")

        if is_paused:
            blockers.append("paused")
            reasons_uz.append("Operator pauzada (yangi lidlar berilmaydi)")
            reasons_ru.append("Оператор на паузе (новых лидов не получает)")
            summary_counts["paused_count"] += 1

        if working >= batch:
            blockers.append("quota_full")
            reasons_uz.append(f"Joriy kvota to'lgan ({working}/{batch}) — yangi lid olish uchun faol lidlarni yopishi kerak")
            reasons_ru.append(f"Квота {working}/{batch} заполнена — нужно закрыть текущие лиды")
            summary_counts["quota_full_count"] += 1

        if gate_effective and open_cb > 0:
            blockers.append("overdue_callback")
            reasons_uz.append(f"Muddati o'tgan callback bor ({open_cb} ta) — geyt yoqilgan")
            reasons_ru.append(f"Просроченный callback ({open_cb} шт) — гейт активен")
            summary_counts["gate_blocked_count"] += 1

        if gate_effective and backlog_c > 0:
            blockers.append("morning_gate_backlog")
            reasons_uz.append(f"Kechagi maxsus lidlar to'smoqda ({backlog_c} ta) — geyt yoqilgan")
            reasons_ru.append(f"Блокирующие спец-лиды ({backlog_c} шт) — гейт активен")
            summary_counts["gate_blocked_count"] += 1

        if req_checkin and not checked_in:
            blockers.append("not_checked_in")
            reasons_uz.append("Bugun davomatda check-in qilinmagan")
            reasons_ru.append("Сегодня нет check-in в табеле")
            summary_counts["not_checked_in_count"] += 1

        if unclosed_yd > 0:
            summary_counts["yesterday_backlog_count"] += 1

        is_eligible = (len(blockers) == 0)

        # Primary blocker
        if not is_eligible:
            primary = blockers[0]
            summary_counts["blocked_count"] += 1
        elif pool_size == 0:
            primary = "empty_pool"
            summary_counts["eligible_count"] += 1
        else:
            primary = "none"
            summary_counts["eligible_count"] += 1

        primary_titles = {
            "none": {"uz": "Lidlar taqsimoti OCHIQ", "ru": "Раздача открыта"},
            "empty_pool": {"uz": "Bazada bo'sh lidlar yo'q", "ru": "Пул пуст (ожидание заявок)"},
            "paused": {"uz": "Operator pauzada", "ru": "Оператор на паузе"},
            "quota_full": {"uz": f"Kvota to'lgan ({working}/{batch})", "ru": f"Квота заполнена ({working}/{batch})"},
            "yesterday_backlog": {"uz": f"Kechagi lidlar to'smoqda ({backlog_c} ta)", "ru": f"Вчерашние лиды ({backlog_c} шт)"},
            "morning_gate_backlog": {"uz": f"Kechagi maxsus lidlar ({backlog_c} ta)", "ru": f"Спец-лиды гейта ({backlog_c} шт)"},
            "overdue_callback": {"uz": f"Muddati o'tgan callback ({open_cb} ta)", "ru": f"Просроченный звонок ({open_cb} шт)"},
            "not_checked_in": {"uz": "Check-in qilinmagan", "ru": "Нет check-in в табеле"},
            "not_active": {"uz": f"Holati: {op.status}", "ru": f"Статус: {op.status}"},
            "auto_off": {"uz": "Avtotizim o'chirilgan", "ru": "Автораздача выключена"},
        }
        pt = primary_titles.get(primary, {"uz": primary, "ru": primary})

        row = {
            "id": op.id,
            "full_name": op.full_name,
            "phone": op.phone,
            "status": op.status,
            "is_paused": is_paused,
            "paused_at": op.paused_at.isoformat() if op.paused_at else None,
            "blocking_gate_enabled": gate_flag,
            "require_checkin_enabled": req_checkin,
            "checked_in_today": checked_in,
            "has_open_shift": open_shift,
            "working_count": working,
            "quota_limit": batch,
            "postponed_count": postponed,
            "carry_count": carry_c,
            "yesterday_unclosed_count": unclosed_yd,
            "open_callbacks_count": open_cb,
            "blocking_leads_count": backlog_c,
            "today_received_count": today_recv,
            "today_calls_count": today_calls,
            "last_lead_assigned_at": last_at.isoformat() if last_at else None,
            "allowed_sheets": allowed_sheets_map.get(op.id, []),
            "has_sheet_restrictions": len(restricted_sheet_names) > 0 and op.id not in allowed_sheets_map,
            "eligible": is_eligible,
            "primary_blocker": primary,
            "primary_blocker_title_uz": pt["uz"],
            "primary_blocker_title_ru": pt["ru"],
            "reasons_uz": reasons_uz if reasons_uz else ["Taqsimot ochiq — yangi lid berishga tayyor"],
            "reasons_ru": reasons_ru if reasons_ru else ["Раздача открыта — готов к приёму"],
        }
        operator_rows.append(row)

    # Сортировка: eligible первыми (working ASC), затем non-eligible (working DESC)
    operator_rows.sort(
        key=lambda r: (
            0 if r["eligible"] else 1,
            r["working_count"] if r["eligible"] else -r["working_count"],
            r["full_name"].lower(),
        )
    )

    if filter_status == "eligible":
        operator_rows = [r for r in operator_rows if r["eligible"]]
    elif filter_status == "blocked":
        operator_rows = [r for r in operator_rows if not r["eligible"]]
    elif filter_status == "paused":
        operator_rows = [r for r in operator_rows if r["is_paused"]]

    selected_detail = None
    if selected_op_obj is None and operator_id:
        selected_op_obj = Operator.objects.filter(id=operator_id).first()
    elif selected_op_obj is None and operator_rows:
        first_id = operator_rows[0]["id"]
        selected_op_obj = next((op for op in ops if op.id == first_id), None)

    if selected_op_obj:
        sel_row = next((r for r in operator_rows if r["id"] == selected_op_obj.id), None)
        if not sel_row:
            sel_diag = operators_distribution_diagnostics(operator_id=selected_op_obj.id)
            sel_row = sel_diag["operators"][0] if sel_diag["operators"] else None

        working_leads_detail = []
        w_qs = (
            Lead.objects.filter(
                operator=selected_op_obj,
                status__in=workable_codes,
                postponed_at__isnull=True,
            )
            .filter(_active_today_filter())
            .order_by("updated_at")[:15]
        )
        for l in w_qs:
            lbl = labels.get(l.status, {"ru": l.status, "uz": l.status})
            hours = int((now - l.updated_at).total_seconds() // 3600) if l.updated_at else 0
            working_leads_detail.append({
                "id": l.id,
                "full_name": l.full_name,
                "phone": l.phone,
                "status": l.status,
                "status_label_ru": lbl["ru"],
                "status_label_uz": lbl["uz"],
                "updated_at": l.updated_at.isoformat() if l.updated_at else None,
                "created_at": l.created_at.isoformat() if l.created_at else None,
                "hours_since_update": hours,
            })

        yesterday_leads_detail = operator_yesterday_unclosed_leads(selected_op_obj, limit=50)

        recent_assignments = []
        ra_qs = (
            LeadAssignment.objects.filter(
                operator=selected_op_obj,
                created_at__gte=today_start,
            )
            .select_related("lead")
            .order_by("-created_at")[:10]
        )
        for a in ra_qs:
            recent_assignments.append({
                "assignment_id": a.id,
                "lead_id": a.lead_id,
                "lead_name": a.lead.full_name if a.lead else "—",
                "source": a.source,
                "created_at": a.created_at.isoformat() if a.created_at else None,
            })

        selected_detail = {
            "operator": sel_row,
            "working_leads": working_leads_detail,
            "yesterday_leads": yesterday_leads_detail,
            "recent_assignments": recent_assignments,
        }

    return {
        "summary": {
            **summary_counts,
            "orphans_count": pool_size,
            "auto_distribution_enabled": auto_on,
            "rr_batch_size": batch,
        },
        "operators": operator_rows,
        "selected_detail": selected_detail,
    }


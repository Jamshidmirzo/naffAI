"""
Собираем operator-state одним batch'ем, гоняем все правила из
`rules.RULES`, сортируем результат urgent → warning → info.

Отдельный кэш-слой (Redis TTL 30s) живёт в `apis.py` — здесь функции
чистые, тестируем без mocks.
"""

from __future__ import annotations

import datetime as dt
from dataclasses import asdict

from django.utils import timezone

from apps.attendance.models import AttendanceLog, AttendanceSettings
from apps.calls.models import CallbackReminder, CallbackReminderStatus
from apps.leads.models import Lead
from apps.leads.selectors import (
    active_lead_status_codes,
    operator_working_lead_count,
    terminal_lead_status_codes,
)
from apps.operators.models import Operator
from apps.sales.models import Sale

from .rules import RULES, Suggestion


# ---------------------------------------------------------------------------
# State builder
# ---------------------------------------------------------------------------


_SEVERITY_ORDER = {"urgent": 0, "warning": 1, "info": 2}


def _shift_start_now(now: dt.datetime | None = None) -> bool:
    """
    True, если локальное время (Asia/Tashkent) уже больше начала смены +
    late-threshold из AttendanceSettings. Используется правилом
    `not_checked_in_today` — до 10:00 не спамить, оператор мог утренний
    login сделать в 10:01.
    """
    now_local = timezone.localtime(now) if now else timezone.localtime()
    try:
        s = AttendanceSettings.objects.get(pk=1)
        shift_start = s.shift_start
        threshold_min = int(s.late_threshold_min or 0)
    except AttendanceSettings.DoesNotExist:
        shift_start = dt.time(10, 0)
        threshold_min = 15
    trigger = (
        dt.datetime.combine(now_local.date(), shift_start).replace(
            tzinfo=now_local.tzinfo
        )
        + dt.timedelta(minutes=threshold_min)
    )
    return now_local >= trigger


def build_operator_state(operator: Operator) -> dict:
    """
    One batch of SQL for all rules — избегаем N+1.

    Ключи должны быть стабильны: rules читают их прямо, тесты моделируют
    state руками. Не ломай контракт без обновления rules.py + tests.
    """
    now = timezone.now()
    today = timezone.localdate()

    working_count = operator_working_lead_count(operator)

    active_codes = list(active_lead_status_codes())
    terminal_codes = set(terminal_lead_status_codes())
    non_terminal = [c for c in active_codes if c not in terminal_codes]

    # Stale assigned — раздали давно, оператор не открыл. Используем
    # `assigned` строго (без `new`, т.к. `new` — вообще не тронутый
    # системой лид, редко встречается на плечах оператора).
    stale_assigned = Lead.objects.filter(
        operator=operator,
        status="assigned",
        updated_at__lt=now - dt.timedelta(hours=24),
    ).count()

    # Stale no_answer — оператор поставил и забыл. Половина суток —
    # обычный порог «нужно перезвонить».
    stale_no_answer = Lead.objects.filter(
        operator=operator,
        status="no_answer",
        updated_at__lt=now - dt.timedelta(hours=12),
    ).count()

    # Overdue callbacks — используем ту же логику, что gate/watcher:
    # PENDING/OVERDUE/SNOOZED, remind_at <= now. Grace-minutes здесь не
    # применяем — оператор должен видеть просрочку как только она
    # реально просрочилась, а не после 30-минутного окна.
    overdue_callbacks = CallbackReminder.objects.filter(
        operator=operator,
        status__in=(
            CallbackReminderStatus.PENDING,
            CallbackReminderStatus.OVERDUE,
            CallbackReminderStatus.SNOOZED,
        ),
        remind_at__lt=now,
    ).count()

    # Check-in — есть ли открытая или сегодняшняя запись attendance.
    # Достаточно `checked_in_at__date == today` — если утром отметился
    # и уже вышел, повторно спрашивать не надо.
    checked_in_today = AttendanceLog.objects.filter(
        operator=operator,
        checked_in_at__date=today,
    ).exists()

    # Postponed > 3 дней — оператор явно отложил лида и забыл.
    stale_postponed = Lead.objects.filter(
        operator=operator,
        status__in=non_terminal,
        postponed_at__isnull=False,
        postponed_at__lt=now - dt.timedelta(days=3),
    ).count()

    # Pending sales — оператор создал, менеджер не подтвердил.
    # Через FK created_by (User), не Operator — так связаны продажи
    # в текущей модели. Если у профиля нет user_id — считаем 0.
    profile = None
    pending_sales = 0
    try:
        # Найдём user'а, у которого profile.operator == этот operator.
        # Обычно операторов-на-один-user — один; берём первого.
        for prof in operator.user_profiles.all():
            profile = prof
            break
        if profile is not None:
            pending_sales = Sale.objects.filter(
                created_by_id=profile.user_id,
                status="pending",
                is_deleted=False,
            ).count()
    except Exception:
        pending_sales = 0

    return {
        "operator": operator,
        "working_count": working_count,
        "stale_assigned": stale_assigned,
        "stale_no_answer": stale_no_answer,
        "overdue_callbacks": overdue_callbacks,
        "checked_in_today": checked_in_today,
        "stale_postponed": stale_postponed,
        "pending_sales": pending_sales,
        "shift_started_now": _shift_start_now(now),
    }


def build_operator_suggestions(operator: Operator) -> list[Suggestion]:
    """Собрать все подсказки, отсортировать: urgent → warning → info."""
    state = build_operator_state(operator)
    out: list[Suggestion] = []
    for rule in RULES:
        try:
            s = rule(operator, state)
        except Exception:  # noqa: BLE001 — правила должны быть best-effort
            # Один плохой rule не должен ломать весь helper.
            continue
        if s is not None:
            out.append(s)
    out.sort(key=lambda s: (_SEVERITY_ORDER.get(s.severity, 9),))
    return out


def suggestions_to_payload(items: list[Suggestion]) -> list[dict]:
    """Плоские dict'ы для JSON-ответа (react-query их сравнивает по ссылке)."""
    return [asdict(s) for s in items]

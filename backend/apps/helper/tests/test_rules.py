"""
Юнит-тесты helper rule-engine.

Правила читают state-dict напрямую, поэтому тестируем в изоляции — без
БД, без фикстур. Отдельно один интеграционный тест на
`build_operator_suggestions` через реальные модели (сортировка по
severity + вчерашний кейс с full_working_queue).
"""

from __future__ import annotations

import datetime as dt

import pytest
from django.core.cache import cache
from django.utils import timezone
from freezegun import freeze_time

from apps.leads.models import Lead, LeadStatus
from apps.operators.models import Operator, OperatorStatus

from apps.helper.rules import (
    check_full_working_queue,
    check_not_checked_in_today,
    check_old_assigned_leads,
    check_overdue_callbacks,
    check_pending_sales,
    check_postponed_stale,
    check_stale_no_answer,
)
from apps.helper.services import build_operator_suggestions


# ---------------------------------------------------------------------------
# Pure rule tests (no DB)
# ---------------------------------------------------------------------------


def test_full_working_queue_fires_at_5():
    """Ключевой rule — вчерашний кейс с Мухлисой (working_count >= 5)."""
    op = object()  # rule читает только state
    s = check_full_working_queue(op, {"working_count": 5})
    assert s is not None
    assert s.id == "full_working_queue"
    assert s.severity == "warning"
    assert s.count == 5
    assert s.action_href == "/my?view=active"


def test_full_working_queue_silent_below_5():
    assert check_full_working_queue(object(), {"working_count": 4}) is None
    assert check_full_working_queue(object(), {"working_count": 0}) is None
    assert check_full_working_queue(object(), {}) is None


def test_old_assigned_fires_at_3():
    s = check_old_assigned_leads(object(), {"stale_assigned": 3})
    assert s is not None
    assert s.id == "old_assigned"
    assert s.severity == "warning"
    assert s.count == 3
    assert check_old_assigned_leads(object(), {"stale_assigned": 2}) is None


def test_stale_no_answer_info():
    s = check_stale_no_answer(object(), {"stale_no_answer": 7})
    assert s is not None
    assert s.severity == "info"
    assert s.count == 7
    assert check_stale_no_answer(object(), {"stale_no_answer": 2}) is None


def test_overdue_callbacks_urgent():
    s = check_overdue_callbacks(object(), {"overdue_callbacks": 1})
    assert s is not None
    assert s.severity == "urgent"
    assert check_overdue_callbacks(object(), {"overdue_callbacks": 0}) is None


def test_not_checked_in_today_needs_shift_started():
    # Смена ещё не началась — молчим, даже если check-in отсутствует.
    assert (
        check_not_checked_in_today(
            object(),
            {"checked_in_today": False, "shift_started_now": False},
        )
        is None
    )
    # Смена началась, check-in ещё нет — urgent.
    s = check_not_checked_in_today(
        object(),
        {"checked_in_today": False, "shift_started_now": True},
    )
    assert s is not None
    assert s.severity == "urgent"
    assert s.action_href == "/profile"

    # Уже отметился — правило молчит.
    assert (
        check_not_checked_in_today(
            object(),
            {"checked_in_today": True, "shift_started_now": True},
        )
        is None
    )


def test_postponed_stale_info():
    s = check_postponed_stale(object(), {"stale_postponed": 4})
    assert s is not None
    assert s.severity == "info"
    assert s.action_href == "/my?view=postponed"
    assert check_postponed_stale(object(), {"stale_postponed": 0}) is None


def test_pending_sales_info():
    s = check_pending_sales(object(), {"pending_sales": 2})
    assert s is not None
    assert s.severity == "info"
    assert s.action_href == "/my/sales"
    assert check_pending_sales(object(), {"pending_sales": 0}) is None


# ---------------------------------------------------------------------------
# Integration: build_operator_suggestions with real DB
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _clear_status_caches():
    """Селекторы leads кэшируют carry/recall codes на 60s — сброс между тестами."""
    cache.delete("carry_over_status_codes")
    cache.delete("recall_after_lunch_status_codes")
    yield
    cache.delete("carry_over_status_codes")
    cache.delete("recall_after_lunch_status_codes")


def _mk_op() -> Operator:
    return Operator.objects.create(full_name="Test", status=OperatorStatus.ACTIVE)


def _mk_assigned(op: Operator, idx: int, *, updated_days_ago: int = 0) -> Lead:
    lead = Lead.objects.create(
        full_name=f"L-{idx}",
        phone=f"+99890{idx:07d}",
        status=LeadStatus.ASSIGNED,
        operator=op,
    )
    Lead.objects.filter(pk=lead.pk).update(
        updated_at=timezone.now() - dt.timedelta(days=updated_days_ago)
    )
    lead.refresh_from_db()
    return lead


@pytest.mark.django_db
def test_suggestions_sorted_urgent_first():
    """
    Оператор с 5+ working (warning) и просроченным callback (urgent) —
    urgent должен быть первым в списке.
    """
    from apps.calls.models import CallbackReminder, CallbackReminderStatus

    op = _mk_op()
    # 5 assigned сегодня → full_working_queue (WARNING)
    for i in range(5):
        _mk_assigned(op, i)
    lead = Lead.objects.filter(operator=op).first()

    # Фикс времени, чтобы правило not_checked_in не выстрелило (10:00 ещё не наступило).
    # Callback создаём ВНУТРИ freeze — иначе remind_at считается от реального now,
    # а не от фиксированного, и rule видит его как «в будущем».
    with freeze_time("2026-08-24 03:00:00"):  # 08:00 Tashkent (UTC+5)
        CallbackReminder.objects.create(
            lead=lead,
            operator=op,
            remind_at=timezone.now() - dt.timedelta(hours=1),
            status=CallbackReminderStatus.PENDING,
        )
        out = build_operator_suggestions(op)

    ids = [s.id for s in out]
    assert "overdue_callbacks" in ids
    assert "full_working_queue" in ids
    # URGENT должен быть первым
    assert out[0].severity == "urgent"
    assert out[0].id == "overdue_callbacks"


@pytest.mark.django_db
def test_muxlisa_case_full_working_queue_fires():
    """
    Реальный вчерашний кейс: 5+ активных non-carry лидов у оператора,
    distribute-watcher не даёт новых. Rule должен сработать и объяснить
    почему нет новых.
    """
    op = _mk_op()
    for i in range(6):
        _mk_assigned(op, i)

    with freeze_time("2026-08-24 03:00:00"):
        out = build_operator_suggestions(op)

    ids = {s.id for s in out}
    assert "full_working_queue" in ids
    fwq = next(s for s in out if s.id == "full_working_queue")
    assert fwq.count == 6
    assert "5" in fwq.body_ru  # объяснение упоминает лимит
    assert fwq.action_href == "/my?view=active"


@pytest.mark.django_db
def test_empty_operator_no_suggestions():
    """Оператор без лидов, без callback'ов, до 10:00 — тишина."""
    op = _mk_op()
    with freeze_time("2026-08-24 03:00:00"):  # 08:00 Tashkent
        out = build_operator_suggestions(op)
    assert out == []

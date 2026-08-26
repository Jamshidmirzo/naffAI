"""
Tests for `forgotten_checkouts_count` / `forgotten_checkouts_bulk`
selectors (enforcement wave 2026-08-26).

Проверяем:
  - считает только auto_closed=True AND backfilled_by_operator_at IS NULL;
  - не считает логи старше `days` окна;
  - не считает обычные (manually closed / normal /checkout) закрытия;
  - bulk-версия даёт тот же результат для каждого id.
"""

from __future__ import annotations

import datetime as dt

import pytest
from django.utils import timezone

from apps.attendance.models import AttendanceLog
from apps.attendance.selectors import (
    forgotten_checkouts_bulk,
    forgotten_checkouts_count,
)
from apps.operators.models import Operator


@pytest.fixture
def op(db):
    return Operator.objects.create(full_name="Op Forgotten", status="active")


@pytest.fixture
def op_b(db):
    return Operator.objects.create(full_name="Op Second", status="active")


def _make_log(op, *, days_ago, auto_closed, backfilled=False):
    now = timezone.now()
    checked_in = now - dt.timedelta(days=days_ago, hours=5)
    log = AttendanceLog.objects.create(
        operator=op,
        checked_in_at=checked_in,
        checked_out_at=checked_in + dt.timedelta(hours=13),
        auto_closed=auto_closed,
    )
    if backfilled:
        log.backfilled_by_operator_at = now
        log.save(update_fields=["backfilled_by_operator_at"])
    return log


@pytest.mark.django_db
def test_counts_only_auto_closed_without_backfill(op):
    _make_log(op, days_ago=1, auto_closed=True)
    _make_log(op, days_ago=2, auto_closed=True)
    _make_log(op, days_ago=3, auto_closed=False)  # обычное закрытие — не считаем
    _make_log(op, days_ago=4, auto_closed=True, backfilled=True)  # backfilled — не считаем
    assert forgotten_checkouts_count(op) == 2


@pytest.mark.django_db
def test_respects_days_window(op):
    _make_log(op, days_ago=5, auto_closed=True)
    _make_log(op, days_ago=45, auto_closed=True)  # за окном 30 дней
    assert forgotten_checkouts_count(op, days=30) == 1
    # Расширим окно — включим старый лог.
    assert forgotten_checkouts_count(op, days=60) == 2


@pytest.mark.django_db
def test_bulk_matches_per_row(op, op_b):
    _make_log(op, days_ago=1, auto_closed=True)
    _make_log(op, days_ago=2, auto_closed=True)
    _make_log(op_b, days_ago=1, auto_closed=True)
    # Также добавим не считающийся лог у op_b — не должен попасть.
    _make_log(op_b, days_ago=1, auto_closed=False)

    counts = forgotten_checkouts_bulk([op.id, op_b.id])
    assert counts[op.id] == 2
    assert counts[op_b.id] == 1


@pytest.mark.django_db
def test_bulk_returns_zero_for_operator_without_logs(op):
    """Оператор без логов должен получить 0, а не отсутствовать в dict'e."""
    counts = forgotten_checkouts_bulk([op.id, 9999])
    assert counts == {op.id: 0, 9999: 0}

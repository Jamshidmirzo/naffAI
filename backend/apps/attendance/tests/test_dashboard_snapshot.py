"""
Smoke tests for `attendance_dashboard_snapshot()` selector.

Snapshot is intentionally scalar-only (counters, no names) — no PII
leaves through it, so its endpoint doesn't require the PIN-gate.
"""
from __future__ import annotations

import datetime as dt

import pytest
from django.utils import timezone

from apps.attendance.models import AttendanceLog
from apps.attendance.selectors import attendance_dashboard_snapshot
from apps.operators.models import Operator, OperatorStatus


def _make_op(name: str, status: str = OperatorStatus.ACTIVE) -> Operator:
    return Operator.objects.create(full_name=name, phone=f"+998900000{name[-3:]}", status=status)


@pytest.mark.django_db
def test_snapshot_empty_returns_zero_counters():
    resp = attendance_dashboard_snapshot()
    assert set(resp.keys()) == {"on_shift", "expected", "late_today"}
    assert resp["on_shift"] == 0
    assert resp["late_today"] == 0
    # expected counts non-inactive operators; empty DB → 0
    assert resp["expected"] == 0


@pytest.mark.django_db
def test_snapshot_counts_open_shifts_only_today():
    op1 = _make_op("Op100")
    op2 = _make_op("Op101")
    now = timezone.now()

    # Open shift, checked in today → counted
    AttendanceLog.objects.create(
        operator=op1, checked_in_at=now, was_late=False, source="qr"
    )
    # Closed shift → NOT counted in on_shift
    AttendanceLog.objects.create(
        operator=op2, checked_in_at=now, checked_out_at=now, was_late=True, source="qr"
    )

    resp = attendance_dashboard_snapshot()
    assert resp["on_shift"] == 1
    assert resp["late_today"] == 1


@pytest.mark.django_db
def test_snapshot_expected_excludes_inactive_operators():
    _make_op("Op200", OperatorStatus.ACTIVE)
    _make_op("Op201", OperatorStatus.TRAINEE)
    _make_op("Op202", OperatorStatus.INACTIVE)

    resp = attendance_dashboard_snapshot()
    # Sunday → 0, weekday → 2 (active + trainee, inactive excluded)
    today = timezone.localdate()
    if today.weekday() == 6:
        assert resp["expected"] == 0
    else:
        assert resp["expected"] == 2

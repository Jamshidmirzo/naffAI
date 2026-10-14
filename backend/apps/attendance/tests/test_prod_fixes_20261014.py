"""
2026-10-14 attendance fixes found in the prod audit:

* a manager's manual pause survives the operator's next check-in;
* payroll of the running month: future days are not absences, the rate is
  on the working days elapsed so far, approved day-offs and days before the
  hire date are not absences, header fines equal the day rows;
* early leave is shown on the day row.
"""

from __future__ import annotations

import datetime as dt
from decimal import Decimal

import pytest
from django.utils import timezone
from freezegun import freeze_time

from apps.attendance.models import AttendanceLog
from apps.attendance.selectors import attendance_payroll_summary, attendance_settings_get
from apps.attendance.services import process_attendance_event
from apps.operators.models import DayOffStatus, Operator, OperatorDayOff
from apps.operators.services import operator_set_paused

pytestmark = pytest.mark.django_db
TZ = timezone.get_current_timezone


@pytest.fixture
def settings_obj():
    s = attendance_settings_get()
    s.shift_start = dt.time(10, 0)
    s.shift_end = dt.time(20, 0)
    s.default_grace_period_min = 20
    s.default_late_penalty_uzs = Decimal("50000")
    s.default_weekly_day_off = 6
    s.save()
    return s


@pytest.fixture
def op():
    return Operator.objects.create(full_name="Fix Op", status="active")


def _log(op, day: dt.date, h: int, m: int, out: tuple[int, int] | None = None, auto: bool = False):
    tz = TZ()
    return AttendanceLog.objects.create(
        operator=op,
        checked_in_at=dt.datetime(day.year, day.month, day.day, h, m, tzinfo=tz),
        checked_out_at=dt.datetime(day.year, day.month, day.day, *out, tzinfo=tz) if out else None,
        auto_closed=auto,
    )


# ------------------------------------------------------------------ pause


def _scan(op):
    process_attendance_event(operator=op, source="qr", initiator="t", ip="10.0.0.1", user_agent="UA", issue_token=False)


def test_manual_pause_survives_check_in(settings_obj, op):
    operator_set_paused(operator=op, paused=True, reason="manual")
    _scan(op)
    op.refresh_from_db()
    assert op.is_paused is True
    assert op.paused_reason == "manual"


def test_end_of_shift_pause_is_lifted_by_check_in(settings_obj, op):
    operator_set_paused(operator=op, paused=True, reason="checkout")
    _scan(op)
    op.refresh_from_db()
    assert op.is_paused is False
    assert op.paused_reason == ""


def test_legacy_pause_without_reason_is_lifted(settings_obj, op):
    Operator.objects.filter(pk=op.pk).update(is_paused=True, paused_reason="")
    op.refresh_from_db()
    _scan(op)
    op.refresh_from_db()
    assert op.is_paused is False


def test_manager_pause_over_checkout_pause_becomes_manual(settings_obj, op):
    operator_set_paused(operator=op, paused=True, reason="checkout")
    operator_set_paused(operator=op, paused=True, reason="manual")
    op.refresh_from_db()
    assert op.paused_reason == "manual"


# ---------------------------------------------------------------- payroll


# March 2026: Sundays are 1, 8, 15, 22, 29 → 26 working days; by Tue 10 March
# 8 of them have passed (2–7, 9, 10).
WORKED_SO_FAR = [2, 3, 4, 5, 6, 7, 9, 10]


def _summary(op):
    return attendance_payroll_summary(op, 2026, 3)["attendance"]


@freeze_time("2026-03-10 18:00:00")
def test_running_month_counts_only_elapsed_days(settings_obj, op):
    for d in WORKED_SO_FAR:
        _log(op, dt.date(2026, 3, d), 10, 0, out=(20, 0))
    s = _summary(op)
    assert s["working_days_planned"] == 26
    assert s["working_days_elapsed"] == 8
    assert s["days_absent"] == 0
    assert s["rate_pct"] == 100.0
    assert s["gate_passed"] is True
    shown_working = [d["date"] for d in s["days"] if d["is_working_day"]]
    assert max(shown_working) == "2026-03-10"  # future days are not listed
    assert not [d for d in s["days"] if d["status"] == "absent"]


@freeze_time("2026-03-10 18:00:00")
def test_approved_day_off_is_not_an_absence(settings_obj, op):
    OperatorDayOff.objects.create(operator=op, date=dt.date(2026, 3, 3), status=DayOffStatus.APPROVED)
    for d in WORKED_SO_FAR:
        if d != 3:
            _log(op, dt.date(2026, 3, d), 10, 0, out=(20, 0))
    s = _summary(op)
    assert s["days_absent"] == 0
    assert s["working_days_planned"] == 25
    assert s["working_days_elapsed"] == 7
    row = next(d for d in s["days"] if d["date"] == "2026-03-03")
    assert row["status"] == "weekend" and row["day_kind"] == "day_off"


@freeze_time("2026-03-10 18:00:00")
def test_days_before_hire_are_not_absences(settings_obj, op):
    op.hired_at = dt.date(2026, 3, 5)
    op.save(update_fields=["hired_at"])
    for d in (5, 6, 7, 9, 10):
        _log(op, dt.date(2026, 3, d), 10, 0, out=(20, 0))
    s = _summary(op)
    assert s["days_absent"] == 0
    assert s["working_days_planned"] == 23
    assert s["rate_pct"] == 100.0
    kinds = {d["date"]: d.get("day_kind") for d in s["days"]}
    assert kinds["2026-03-02"] == kinds["2026-03-04"] == "not_employed"


@freeze_time("2026-03-10 18:00:00")
def test_header_fines_equal_day_rows_even_when_gate_fails(settings_obj, op):
    for d in (2, 3, 4):
        _log(op, dt.date(2026, 3, d), 10, 45, out=(20, 0))  # late, grace is 20 min
    s = _summary(op)
    assert s["gate_passed"] is False  # 3 of 8 elapsed days
    rows_total = sum(Decimal(d["deduction_uzs"]) for d in s["days"])
    assert Decimal(s["late_penalty_total"]) == rows_total == Decimal("150000")
    assert s["block_earned"] == "0"


@freeze_time("2026-03-10 18:00:00")
def test_early_leave_is_shown_on_the_day(settings_obj, op):
    _log(op, dt.date(2026, 3, 2), 10, 0, out=(15, 0))
    _log(op, dt.date(2026, 3, 3), 10, 0, out=(23, 0), auto=True)  # forgot to check out
    rows = {d["date"]: d for d in _summary(op)["days"]}
    assert rows["2026-03-02"]["minutes_early"] == 300
    assert "Ушёл раньше на 300 мин" in rows["2026-03-02"]["note"]
    assert rows["2026-03-03"]["minutes_early"] == 0

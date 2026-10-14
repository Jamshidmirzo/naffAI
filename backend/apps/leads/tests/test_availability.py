"""
2026-10-14: automatic lead distribution only to operators who are at work.

Complaint from prod: operators who did not come (no check-in) and paused
operators still received leads (morning split at 08:30, refill, qimmatlik
retry, sheet alias). One rule now lives in apps.leads.availability and every
automatic path uses it; untouched leads of absent operators go back to the
pool and are refilled to people on shift.
"""

from __future__ import annotations

import datetime as dt

import pytest
from django.test import override_settings
from django.utils import timezone
from freezegun import freeze_time

from apps.attendance.models import AttendanceLog
from apps.attendance.selectors import attendance_settings_get
from apps.leads.availability import (
    operator_unavailable_reason,
    operators_available_for_auto_leads,
)
from apps.leads.models import Lead, LeadAssignment, LeadAssignmentSource, LeadStatus
from apps.leads.selectors import operators_eligible_for_new_leads
from apps.leads.services import (
    lead_qimmatlik_retry,
    morning_distribute_leads,
    refill_operator_leads,
    release_leads_of_absent_operators,
)
from apps.operators.models import Operator, OperatorStatus

pytestmark = pytest.mark.django_db

SHIFT_ON = override_settings(LEADS_REQUIRE_OPEN_SHIFT=True)


def _op(name: str, **kw) -> Operator:
    return Operator.objects.create(full_name=name, status=OperatorStatus.ACTIVE, **kw)


def _check_in(op: Operator, *, at: dt.datetime | None = None, out: dt.datetime | None = None) -> AttendanceLog:
    return AttendanceLog.objects.create(operator=op, checked_in_at=at or timezone.now(), checked_out_at=out)


def _orphan(i: int) -> Lead:
    return Lead.objects.create(full_name=f"O-{i}", phone=f"+99890{i:07d}", status=LeadStatus.NEW)


def _enforce(on: bool) -> None:
    s = attendance_settings_get()
    s.enforce_daily_checkin = on
    s.save(update_fields=["enforce_daily_checkin"])


# ---------------------------------------------------------------- the rule


@SHIFT_ON
def test_only_operators_on_shift_are_available():
    _enforce(True)
    absent = _op("absent")
    working = _op("working")
    paused = _op("paused", is_paused=True)
    left = _op("left")
    _check_in(working)
    _check_in(paused)
    _check_in(left, at=timezone.now() - dt.timedelta(hours=3), out=timezone.now() - dt.timedelta(hours=1))

    assert set(operators_available_for_auto_leads()) == {working}
    assert operator_unavailable_reason(absent) == "not_on_shift"
    assert operator_unavailable_reason(paused) == "paused"
    assert operator_unavailable_reason(left) == "not_on_shift"
    assert operator_unavailable_reason(working) is None


@SHIFT_ON
def test_per_operator_flag_when_global_check_in_is_off():
    _enforce(False)
    free = _op("free", require_checkin_enabled=False)
    strict = _op("strict", require_checkin_enabled=True)
    assert set(operators_available_for_auto_leads()) == {free}
    _check_in(strict)
    assert set(operators_available_for_auto_leads()) == {free, strict}


@override_settings(LEADS_REQUIRE_OPEN_SHIFT=False)
def test_emergency_switch_ignores_shifts():
    _enforce(True)
    op = _op("no-shift")
    assert operator_unavailable_reason(op) is None


# ------------------------------------------------------- automatic paths


@SHIFT_ON
def test_morning_split_skips_operators_not_on_shift():
    _enforce(True)
    absent = _op("absent")
    working = _op("working")
    _check_in(working)
    for i in range(6):
        _orphan(i)

    counts = morning_distribute_leads(seed=1)

    assert absent.id not in counts
    assert counts.get(working.id, 0) > 0
    assert not Lead.objects.filter(operator=absent).exists()


@SHIFT_ON
def test_refill_gives_nothing_to_absent_operator():
    _enforce(True)
    absent = _op("absent")
    for i in range(6):
        _orphan(i)
    assert refill_operator_leads(operator=absent, size=5) == []


@SHIFT_ON
def test_round_robin_pool_excludes_absent_and_paused():
    _enforce(True)
    _op("absent")
    _op("paused", is_paused=True)
    working = _op("working")
    _check_in(working)
    assert list(operators_eligible_for_new_leads()) == [working]
    assert list(operators_eligible_for_new_leads(bypass_gate=True)) == [working]


@SHIFT_ON
def test_qimmatlik_retry_waits_for_someone_on_shift():
    _enforce(True)
    first = _op("first")
    _op("absent")
    lead = Lead.objects.create(
        full_name="Q",
        phone="+998901234567",
        status="qimmatlik_qildi",
        operator=first,
        metadata={"qimmatlik_retry_at": timezone.now().isoformat()},
    )
    LeadAssignment.objects.create(lead=lead, operator=first, source=LeadAssignmentSource.AUTO_REFILL)

    assert lead_qimmatlik_retry(lead) is None

    lead.refresh_from_db()
    assert lead.status == "qimmatlik_qildi"  # not closed as LOST
    assert lead.operator_id == first.id
    assert "qimmatlik_retry_at" in (lead.metadata or {})  # watcher retries later


# ---------------------------------------------- leads of absent operators


def _assign(op: Operator, i: int, source: str = LeadAssignmentSource.MORNING_SPLIT) -> Lead:
    lead = Lead.objects.create(full_name=f"A-{i}", phone=f"+99891{i:07d}", status=LeadStatus.NEW, operator=op)
    LeadAssignment.objects.create(lead=lead, operator=op, source=source, active=True)
    return lead


@SHIFT_ON
def test_untouched_leads_of_absent_operator_return_to_pool_after_shift_start():
    _enforce(True)
    s = attendance_settings_get()
    s.shift_start = dt.time(10, 0)
    s.save(update_fields=["shift_start"])
    absent = _op("absent")
    auto = [_assign(absent, i) for i in range(3)]
    manual = _assign(absent, 10, source=LeadAssignmentSource.ADMIN_REASSIGN)

    tz = timezone.get_current_timezone()
    with freeze_time(dt.datetime(2026, 10, 14, 10, 30, tzinfo=tz)):
        assert release_leads_of_absent_operators(after_minutes=60) == {}  # too early
    with freeze_time(dt.datetime(2026, 10, 14, 11, 5, tzinfo=tz)):
        released = release_leads_of_absent_operators(after_minutes=60)

    assert released == {absent.id: 3}
    for lead in auto:
        lead.refresh_from_db()
        assert lead.operator_id is None and lead.status == LeadStatus.NEW
    manual.refresh_from_db()
    assert manual.operator_id == absent.id  # a manager's choice stays


@SHIFT_ON
def test_operator_on_shift_keeps_leads():
    _enforce(True)
    s = attendance_settings_get()
    s.shift_start = dt.time(10, 0)
    s.save(update_fields=["shift_start"])
    working = _op("working")
    _assign(working, 1)
    tz = timezone.get_current_timezone()
    with freeze_time(dt.datetime(2026, 10, 14, 12, 0, tzinfo=tz)):
        _check_in(working)
        assert release_leads_of_absent_operators(after_minutes=60) == {}
    assert Lead.objects.filter(operator=working).count() == 1

"""
GET /api/operators/floor/ — «Пульт зала» (design-atlas V2, 2026-10-14).

Покрываем:
  * права (operator → 403, anon → 401/403, senior → 200);
  * скоуп `visible_operator_ids` + `?manager_id=` (только super_manager /
    superadmin; у manager'а игнорируется; мусор → 400);
  * формат ответа;
  * PIN-скрытие `checked_in_at` / `late_minutes` (`pin_verified`);
  * все ветки `state` (чистая функция + интеграционно через ORM);
  * счётчики: working_count / sales_today / overdue_callbacks / plan.
"""

from __future__ import annotations

import datetime as dt
from decimal import Decimal

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from freezegun import freeze_time
from rest_framework.test import APIClient

from apps.attendance.models import AttendanceLog, AttendancePinSession, AttendanceSettings
from apps.calls.models import CallAttempt, CallbackReminder, CallbackReminderStatus
from apps.catalog.models import Channel
from apps.leads.models import Lead, LeadStatus
from apps.operators.models import (
    DayOffStatus,
    Operator,
    OperatorDayOff,
    OperatorMonthlyPlan,
    OperatorStatus,
)
from apps.operators.selectors import FloorState, floor_state_resolve, operators_floor_snapshot
from apps.sales.models import Sale, SaleOperator
from apps.users.models import Profile, Role

User = get_user_model()

URL = "/api/operators/floor/"


def _local(y, m, d, hh, mm=0) -> dt.datetime:
    return dt.datetime(y, m, d, hh, mm, tzinfo=timezone.get_current_timezone())


# Среда, 14.10.2026 12:00 по локальному времени (не воскресенье → не
# дефолтный weekly_day_off=6).
NOW = _local(2026, 10, 14, 12, 0)


def _mk_user(username: str, role: str, **profile) -> User:
    u = User.objects.create_user(username=username, password="x")
    Profile.objects.create(user=u, role=role, **profile)
    return u


@pytest.fixture
def settings_row(db):
    obj, _ = AttendanceSettings.objects.get_or_create(pk=1)
    obj.shift_start = dt.time(10, 0)
    obj.late_threshold_min = 15
    obj.default_weekly_day_off = 6
    obj.save()
    return obj


@pytest.fixture
def manager(db):
    return _mk_user("floor_mgr", Role.MANAGER)


@pytest.fixture
def other_manager(db):
    return _mk_user("floor_mgr2", Role.MANAGER)


@pytest.fixture
def super_manager(db):
    return _mk_user("floor_sm", Role.SUPER_MANAGER)


@pytest.fixture
def superadmin(db):
    return _mk_user("floor_root", Role.SUPERADMIN)


@pytest.fixture
def ops(db, manager, other_manager):
    return {
        "mine": Operator.objects.create(
            full_name="A Mine", status=OperatorStatus.ACTIVE, managed_by=manager
        ),
        "trainee": Operator.objects.create(
            full_name="B Trainee", status=OperatorStatus.TRAINEE, managed_by=manager
        ),
        "other": Operator.objects.create(
            full_name="C Other", status=OperatorStatus.ACTIVE, managed_by=other_manager
        ),
        "pool": Operator.objects.create(full_name="D Pool", status=OperatorStatus.ACTIVE),
        "gone": Operator.objects.create(
            full_name="E Gone", status=OperatorStatus.INACTIVE, managed_by=manager
        ),
    }


def _client(user) -> APIClient:
    c = APIClient()
    c.force_authenticate(user)
    return c


def _ids(resp) -> set[int]:
    return {row["id"] for row in resp.data["operators"]}


# ---------------------------------------------------------------------------
# Permissions
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_floor_permissions(settings_row, ops, manager):
    op_user = _mk_user("floor_op", Role.OPERATOR, operator=ops["mine"])
    assert APIClient().get(URL).status_code in (401, 403)
    assert _client(op_user).get(URL).status_code == 403
    assert _client(manager).get(URL).status_code == 200


# ---------------------------------------------------------------------------
# Scope + manager_id
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_floor_scope_manager_sees_own_and_pool_not_inactive(settings_row, ops, manager):
    resp = _client(manager).get(URL)
    assert resp.status_code == 200
    assert _ids(resp) == {ops["mine"].id, ops["trainee"].id, ops["pool"].id}


@pytest.mark.django_db
def test_floor_manager_id_filter_for_super_manager(settings_row, ops, super_manager, manager):
    c = _client(super_manager)
    all_ids = _ids(c.get(URL))
    assert all_ids == {ops["mine"].id, ops["trainee"].id, ops["other"].id, ops["pool"].id}

    assert _ids(c.get(URL, {"manager_id": manager.id})) == {ops["mine"].id, ops["trainee"].id}
    assert _ids(c.get(URL, {"manager_id": "none"})) == {ops["pool"].id}
    assert c.get(URL, {"manager_id": "abc"}).status_code == 400


@pytest.mark.django_db
def test_floor_manager_id_ignored_for_plain_manager(settings_row, ops, manager, other_manager):
    resp = _client(manager).get(URL, {"manager_id": other_manager.id})
    assert resp.status_code == 200
    # Параметр проигнорирован — обычный scope, без чужих операторов.
    assert _ids(resp) == {ops["mine"].id, ops["trainee"].id, ops["pool"].id}


@pytest.mark.django_db
def test_floor_manager_id_superadmin(settings_row, ops, superadmin, other_manager):
    resp = _client(superadmin).get(URL, {"manager_id": other_manager.id})
    assert _ids(resp) == {ops["other"].id}


# ---------------------------------------------------------------------------
# Format + PIN
# ---------------------------------------------------------------------------

ROW_KEYS = {
    "id", "full_name", "status", "managed_by_id", "avatar_url", "state",
    "call_started_at", "call_is_estimate", "paused_at", "checked_in_at",
    "late_minutes", "working_count", "quota", "sales_today",
    "sales_today_amount", "overdue_callbacks", "plan_target", "plan_actual",
}


@pytest.mark.django_db
def test_floor_format(settings_row, ops, manager, settings):
    settings.RR_BATCH_SIZE = 5
    with freeze_time(NOW):
        resp = _client(manager).get(URL)
    assert resp.status_code == 200
    data = resp.data
    assert set(data.keys()) == {"generated_at", "pin_verified", "rr_batch_size", "operators"}
    assert data["rr_batch_size"] == 5
    assert data["pin_verified"] is False
    assert data["generated_at"].startswith("2026-10-14T12:00")
    row = next(r for r in data["operators"] if r["id"] == ops["mine"].id)
    assert set(row.keys()) == ROW_KEYS
    assert row["status"] == "active"
    assert row["managed_by_id"] == manager.id
    assert row["quota"] == 5
    assert row["sales_today_amount"] == "0"
    assert row["plan_target"] is None
    assert row["plan_actual"] == 0
    assert row["call_is_estimate"] is False


@pytest.mark.django_db
def test_floor_pin_hides_personal_attendance_but_state_uses_it(settings_row, ops, manager):
    op = ops["mine"]
    # Пришёл в 11:40 (shift 10:00 + 15 мин grace → опоздал на 85 мин).
    AttendanceLog.objects.create(
        operator=op, checked_in_at=_local(2026, 10, 14, 11, 40), was_late=True
    )
    with freeze_time(NOW):
        resp = _client(manager).get(URL)
    row = next(r for r in resp.data["operators"] if r["id"] == op.id)
    assert resp.data["pin_verified"] is False
    assert row["state"] == FloorState.LATE
    assert row["checked_in_at"] is None
    assert row["late_minutes"] is None

    with freeze_time(NOW):
        AttendancePinSession.objects.create(user=manager, verified_at=timezone.now())
        resp = _client(manager).get(URL)
    row = next(r for r in resp.data["operators"] if r["id"] == op.id)
    assert resp.data["pin_verified"] is True
    assert row["checked_in_at"].startswith("2026-10-14T11:40")
    assert row["late_minutes"] == 85


@pytest.mark.django_db
def test_floor_pin_superadmin_bypass(settings_row, ops, superadmin):
    resp = _client(superadmin).get(URL)
    assert resp.data["pin_verified"] is True


@pytest.mark.django_db
def test_floor_pin_session_expired(settings_row, ops, manager):
    AttendancePinSession.objects.create(
        user=manager, verified_at=timezone.now() - dt.timedelta(hours=2)
    )
    assert _client(manager).get(URL).data["pin_verified"] is False


# ---------------------------------------------------------------------------
# State — pure rule, every branch
# ---------------------------------------------------------------------------


def _resolve(**overrides) -> str:
    kwargs = dict(
        is_day_off=False,
        is_paused=False,
        has_recent_open_call=False,
        first_checkin_at=NOW - dt.timedelta(hours=2),
        first_checkin_was_late=False,
        has_open_shift=True,
        late_deadline=_local(2026, 10, 14, 10, 15),
        now=NOW,
    )
    kwargs.update(overrides)
    return floor_state_resolve(**kwargs)


def test_state_rule_branches():
    # dayoff beats everything
    assert _resolve(is_day_off=True, is_paused=True, has_recent_open_call=True) == "dayoff"
    # pause beats call
    assert _resolve(is_paused=True, has_recent_open_call=True) == "pause"
    assert _resolve(has_recent_open_call=True) == "call"
    # no check-in: before / after shift_start + grace
    assert _resolve(first_checkin_at=None, now=_local(2026, 10, 14, 10, 10)) == "off"
    assert _resolve(first_checkin_at=None) == "absent"
    # checked out for the day
    assert _resolve(has_open_shift=False) == "off"
    # late within 60 min / after 60 min
    assert (
        _resolve(first_checkin_at=NOW - dt.timedelta(minutes=20), first_checkin_was_late=True)
        == "late"
    )
    assert (
        _resolve(first_checkin_at=NOW - dt.timedelta(minutes=61), first_checkin_was_late=True)
        == "wait"
    )
    assert _resolve() == "wait"


# ---------------------------------------------------------------------------
# State — integration through ORM
# ---------------------------------------------------------------------------


def _states(manager_or_actor_ids, **kw) -> dict[int, str]:
    with freeze_time(NOW):
        snap = operators_floor_snapshot(operator_ids=manager_or_actor_ids, pin_verified=True, **kw)
    return {r["id"]: r["state"] for r in snap["operators"]}


def _checkin(op, hh, mm, *, late=False, out=None):
    return AttendanceLog.objects.create(
        operator=op,
        checked_in_at=_local(2026, 10, 14, hh, mm),
        checked_out_at=out,
        was_late=late,
    )


@pytest.mark.django_db
def test_state_integration_all_branches(settings_row):
    mk = lambda n, **kw: Operator.objects.create(full_name=n, status="active", **kw)  # noqa: E731
    dayoff_req = mk("dayoff-request")
    dayoff_weekly = mk("dayoff-weekly", weekly_day_off=NOW.weekday())
    paused = mk("paused", is_paused=True, paused_at=NOW - dt.timedelta(hours=1))
    calling = mk("calling")
    stale_call = mk("stale-call")
    absent = mk("absent")
    off_evening = mk("off-evening-shift", shift_start=dt.time(14, 0))
    left = mk("left")
    late = mk("late")
    waiting = mk("waiting")
    late_long_ago = mk("late-long-ago")

    OperatorDayOff.objects.create(operator=dayoff_req, date=NOW.date(), status=DayOffStatus.APPROVED)
    # Pending day-off не считается.
    pending_dayoff = mk("pending-dayoff")
    OperatorDayOff.objects.create(operator=pending_dayoff, date=NOW.date(), status=DayOffStatus.PENDING)
    _checkin(pending_dayoff, 9, 55)

    lead = Lead.objects.create(full_name="L", phone="+998901112233", status=LeadStatus.NEW)
    CallAttempt.objects.create(lead=lead, operator=calling, started_at=NOW - dt.timedelta(minutes=5))
    CallAttempt.objects.create(
        lead=lead, operator=stale_call, started_at=NOW - dt.timedelta(minutes=20)
    )
    _checkin(calling, 9, 50)
    _checkin(stale_call, 9, 50)
    _checkin(left, 9, 50, out=_local(2026, 10, 14, 11, 0))
    _checkin(late, 11, 30, late=True)
    _checkin(waiting, 9, 58)
    _checkin(late_long_ago, 10, 40, late=True)

    states = _states([o.id for o in Operator.objects.all()])
    assert states[dayoff_req.id] == "dayoff"
    assert states[dayoff_weekly.id] == "dayoff"
    assert states[paused.id] == "pause"
    assert states[calling.id] == "call"
    assert states[stale_call.id] == "wait"
    assert states[absent.id] == "absent"
    assert states[off_evening.id] == "off"
    assert states[left.id] == "off"
    assert states[late.id] == "late"
    assert states[waiting.id] == "wait"
    assert states[late_long_ago.id] == "wait"
    assert states[pending_dayoff.id] == "wait"


@pytest.mark.django_db
def test_call_fields_and_paused_at(settings_row):
    op = Operator.objects.create(full_name="Caller", status="active")
    lead = Lead.objects.create(full_name="L", phone="+998901112244", status=LeadStatus.NEW)
    CallAttempt.objects.create(lead=lead, operator=op, started_at=NOW - dt.timedelta(minutes=3))
    # Завершённый звонок не открыт.
    CallAttempt.objects.create(
        lead=lead, operator=op, started_at=NOW - dt.timedelta(minutes=1), outcome="no_answer",
        ended_at=NOW,
    )
    with freeze_time(NOW):
        row = operators_floor_snapshot(operator_ids=[op.id], pin_verified=False)["operators"][0]
    assert row["state"] == "call"
    assert row["call_is_estimate"] is True
    assert row["call_started_at"].startswith("2026-10-14T11:57")
    assert row["paused_at"] is None


# ---------------------------------------------------------------------------
# Counters
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_floor_counters(settings_row, settings):
    settings.CALLBACK_OVERDUE_GRACE_MINUTES = 30
    op = Operator.objects.create(full_name="Counter", status="active")
    peer = Operator.objects.create(full_name="Peer", status="active")
    channel = Channel.objects.create(name="Telegram")

    # Продажи: 2 подтверждённые сегодня, 1 pending, 1 вчера, 1 возврат.
    def sale(amount, *, sold_at=NOW - dt.timedelta(hours=1), status="confirmed", returned=False):
        s = Sale.objects.create(
            imei="490154203237518", phone_model="X", operator=op, channel=channel,
            amount=Decimal(amount), discount=Decimal("0"), sold_at=sold_at,
            status=status, is_returned=returned,
        )
        SaleOperator.objects.create(sale=s, operator=op, amount=Decimal(amount))
        return s

    sale("10000000")
    sale("21500000")
    sale("5000000", status="pending")
    sale("7000000", sold_at=NOW - dt.timedelta(days=1))
    sale("9000000", returned=True)
    OperatorMonthlyPlan.objects.create(
        operator=op, year=NOW.year, month=NOW.month, target_amount=Decimal("100000000")
    )

    lead = Lead.objects.create(full_name="L", phone="+998901112255", status=LeadStatus.NEW, operator=op)
    # Overdue: remind_at давно в прошлом; не-overdue: в пределах grace; done — не считается.
    CallbackReminder.objects.create(lead=lead, operator=op, remind_at=NOW - dt.timedelta(hours=2))
    CallbackReminder.objects.create(
        lead=lead, operator=op, remind_at=NOW - dt.timedelta(hours=3),
        status=CallbackReminderStatus.SNOOZED,
    )
    CallbackReminder.objects.create(lead=lead, operator=op, remind_at=NOW - dt.timedelta(minutes=10))
    CallbackReminder.objects.create(
        lead=lead, operator=op, remind_at=NOW - dt.timedelta(hours=5),
        status=CallbackReminderStatus.DONE,
    )
    CallbackReminder.objects.create(lead=lead, operator=peer, remind_at=NOW - dt.timedelta(hours=5))

    with freeze_time(NOW):
        snap = operators_floor_snapshot(operator_ids=[op.id, peer.id], pin_verified=True)
    row = next(r for r in snap["operators"] if r["id"] == op.id)
    assert row["sales_today"] == 2
    assert row["sales_today_amount"] == "31500000"
    assert row["overdue_callbacks"] == 2
    assert row["plan_target"] == 100000000
    # План месяца — тот же расчёт, что /operators/: все confirmed за месяц
    # (вчерашняя тоже, если в том же месяце).
    assert row["plan_actual"] == 38500000
    assert row["working_count"] >= 1
    peer_row = next(r for r in snap["operators"] if r["id"] == peer.id)
    assert peer_row["overdue_callbacks"] == 1
    assert peer_row["sales_today"] == 0


@pytest.mark.django_db
def test_floor_empty_scope_returns_empty_list(settings_row):
    snap = operators_floor_snapshot(operator_ids=[], pin_verified=False)
    assert snap["operators"] == []
    assert "rr_batch_size" in snap

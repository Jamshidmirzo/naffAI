"""
Tests for /api/attendance/me/current/ new fields (enforcement wave
2026-08-26): `require_checkin_enabled`, `checkout_reminder_active`,
`pending_backfill_log`.
"""

from __future__ import annotations

import datetime as dt

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from apps.attendance.models import AttendanceLog
from apps.operators.models import Operator
from apps.users.models import Profile, Role

User = get_user_model()


@pytest.fixture
def client():
    return APIClient()


@pytest.fixture
def op(db):
    return Operator.objects.create(full_name="Test Op", status="active")


@pytest.fixture
def op_user(db, op):
    u = User.objects.create_user(username="op_mecur", password="x")
    Profile.objects.create(user=u, role=Role.OPERATOR, operator=op)
    return u


@pytest.mark.django_db
def test_me_current_default_flags_off(client, op, op_user):
    """По умолчанию require_checkin_enabled=False, никаких напоминаний."""
    client.force_authenticate(op_user)
    r = client.get("/api/attendance/me/current/")
    assert r.status_code == 200
    body = r.json()
    assert body["require_checkin_enabled"] is False
    assert body["checkout_reminder_active"] is False
    assert body["pending_backfill_log"] is None


@pytest.mark.django_db
def test_me_current_require_checkin_flag_reflects_operator(client, op, op_user):
    op.require_checkin_enabled = True
    op.save(update_fields=["require_checkin_enabled"])
    client.force_authenticate(op_user)
    r = client.get("/api/attendance/me/current/")
    assert r.status_code == 200
    assert r.json()["require_checkin_enabled"] is True


@pytest.mark.django_db
def test_me_current_reminder_active_when_marker_set(client, op, op_user):
    """
    Если cron уже пометил open_log через checkout_reminder_sent_at —
    фронт получает `checkout_reminder_active=True`.
    """
    log = AttendanceLog.objects.create(
        operator=op,
        checked_in_at=timezone.now() - dt.timedelta(hours=9),
    )
    log.checkout_reminder_sent_at = timezone.now()
    log.save(update_fields=["checkout_reminder_sent_at"])
    client.force_authenticate(op_user)
    r = client.get("/api/attendance/me/current/")
    assert r.status_code == 200
    body = r.json()
    assert body["checkout_reminder_active"] is True
    assert body["open_log"]["checkout_reminder_sent_at"] is not None


@pytest.mark.django_db
def test_me_current_pending_backfill_returns_yesterday_log(client, op, op_user):
    """Вчерашний auto_closed без backfill → pending_backfill_log непустой.

    Гейтится по `require_checkin_enabled` — сначала включаем флаг.
    """
    op.require_checkin_enabled = True
    op.save(update_fields=["require_checkin_enabled"])
    now = timezone.now()
    checked_in = now - dt.timedelta(days=1, hours=5)
    log = AttendanceLog.objects.create(
        operator=op,
        checked_in_at=checked_in,
        checked_out_at=now - dt.timedelta(days=1) + dt.timedelta(hours=13),
        auto_closed=True,
    )
    client.force_authenticate(op_user)
    r = client.get("/api/attendance/me/current/")
    assert r.status_code == 200
    pending = r.json()["pending_backfill_log"]
    assert pending is not None
    assert pending["id"] == log.id


@pytest.mark.django_db
def test_me_current_pending_backfill_skips_when_flag_off(client, op, op_user):
    """Prod-safety: без require_checkin_enabled — pending_backfill_log=None,
    даже если auto_closed лог существует. Иначе prod-операторы утром словят
    блокирующий модал по историческим логам."""
    now = timezone.now()
    AttendanceLog.objects.create(
        operator=op,
        checked_in_at=now - dt.timedelta(days=1, hours=5),
        checked_out_at=now - dt.timedelta(days=1) + dt.timedelta(hours=13),
        auto_closed=True,
    )
    assert op.require_checkin_enabled is False
    client.force_authenticate(op_user)
    r = client.get("/api/attendance/me/current/")
    assert r.status_code == 200
    assert r.json()["pending_backfill_log"] is None


@pytest.mark.django_db
def test_me_current_pending_backfill_skips_after_backfill(client, op, op_user):
    """После заполнения backfilled_by_operator_at → лог исчезает из pending."""
    op.require_checkin_enabled = True
    op.save(update_fields=["require_checkin_enabled"])
    now = timezone.now()
    log = AttendanceLog.objects.create(
        operator=op,
        checked_in_at=now - dt.timedelta(days=1, hours=5),
        checked_out_at=now - dt.timedelta(days=1) + dt.timedelta(hours=13),
        auto_closed=True,
        backfilled_by_operator_at=now,
    )
    client.force_authenticate(op_user)
    r = client.get("/api/attendance/me/current/")
    assert r.json()["pending_backfill_log"] is None
    assert AttendanceLog.objects.get(id=log.id).backfilled_by_operator_at is not None


@pytest.mark.django_db
def test_me_current_pending_backfill_skips_old_logs(client, op, op_user):
    """Логи старше 3 дней (окно pending_backfill) не показываются."""
    op.require_checkin_enabled = True
    op.save(update_fields=["require_checkin_enabled"])
    old_when = timezone.now() - dt.timedelta(days=10)
    AttendanceLog.objects.create(
        operator=op,
        checked_in_at=old_when,
        checked_out_at=old_when + dt.timedelta(hours=13),
        auto_closed=True,
    )
    client.force_authenticate(op_user)
    r = client.get("/api/attendance/me/current/")
    assert r.json()["pending_backfill_log"] is None

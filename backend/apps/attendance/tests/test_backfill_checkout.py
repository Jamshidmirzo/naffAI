"""
Tests for POST /api/attendance/me/backfill-checkout/ (enforcement wave
2026-08-26).

Проверяем:
  - успешный backfill обновляет checked_out_at и backfilled_by_operator_at;
  - валидация нижней границы (checked_out_at < check_in + 30мин);
  - валидация верхней границы (> N часов);
  - нельзя backfill'ить чужой лог;
  - нельзя backfill'ить дважды;
  - нельзя backfill'ить не auto_closed лог;
  - forgotten_checkouts_count после backfill'a — уменьшается;
  - Notification менеджерам создаётся.
"""

from __future__ import annotations

import datetime as dt

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from apps.attendance.models import AttendanceLog, AttendanceSettings
from apps.attendance.selectors import forgotten_checkouts_count
from apps.notifications.models import Notification
from apps.operators.models import Operator
from apps.users.models import Profile, Role

User = get_user_model()


@pytest.fixture
def client():
    return APIClient()


@pytest.fixture
def op(db):
    return Operator.objects.create(full_name="Backfill Op", status="active")


@pytest.fixture
def op_user(db, op):
    u = User.objects.create_user(username="op_backfill", password="x")
    Profile.objects.create(user=u, role=Role.OPERATOR, operator=op)
    return u


@pytest.fixture
def other_op(db):
    return Operator.objects.create(full_name="Other", status="active")


@pytest.fixture
def manager_user(db):
    u = User.objects.create_user(username="mgr_backfill", password="x")
    Profile.objects.create(user=u, role=Role.MANAGER)
    return u


@pytest.fixture
def att_settings(db):
    obj, _ = AttendanceSettings.objects.get_or_create(pk=1)
    obj.max_backfill_hours = 14
    obj.save()
    return obj


def _make_yesterday_auto_closed_log(op: Operator) -> AttendanceLog:
    """Симулируем «оператор вчера пришёл в 10:00, забыл выйти, cron
    закрыл в 23:00»."""
    now = timezone.now()
    checked_in = now.replace(hour=10, minute=0, second=0, microsecond=0) - dt.timedelta(days=1)
    auto_closed_at = now.replace(hour=23, minute=0, second=0, microsecond=0) - dt.timedelta(days=1)
    return AttendanceLog.objects.create(
        operator=op,
        checked_in_at=checked_in,
        checked_out_at=auto_closed_at,
        auto_closed=True,
    )


@pytest.mark.django_db(transaction=True)
def test_backfill_success(client, op, op_user, att_settings, manager_user):
    """
    transaction=True — чтобы `transaction.on_commit(...)` в service
    _notify_managers_backfill сработал; в дефолтном django_db (обёртка в
    транзакции без commit'a) он был бы пропущен.
    """
    log = _make_yesterday_auto_closed_log(op)
    # Оператор говорит: «вчера ушёл в 18:00»
    real_checkout = log.checked_in_at.replace(hour=18, minute=0)

    client.force_authenticate(op_user)
    r = client.post(
        "/api/attendance/me/backfill-checkout/",
        data={
            "log_id": log.id,
            "checked_out_at": real_checkout.isoformat(),
        },
        format="json",
    )
    assert r.status_code == 200, r.json()
    body = r.json()
    assert body["auto_closed"] is True  # сохраняем аудит
    assert body["backfilled_by_operator_at"] is not None
    log.refresh_from_db()
    assert log.checked_out_at.hour == 18
    assert log.backfilled_by_operator_at is not None
    # Manager получает notification
    assert Notification.objects.filter(recipient=manager_user).count() == 1
    n = Notification.objects.filter(recipient=manager_user).first()
    assert n.metadata.get("kind") == "attendance_backfill"


@pytest.mark.django_db
def test_backfill_too_early_rejected(client, op, op_user, att_settings):
    log = _make_yesterday_auto_closed_log(op)
    # Пытаемся ввести уход через 10 минут после прихода — отказ.
    too_early = log.checked_in_at + dt.timedelta(minutes=10)
    client.force_authenticate(op_user)
    r = client.post(
        "/api/attendance/me/backfill-checkout/",
        data={"log_id": log.id, "checked_out_at": too_early.isoformat()},
        format="json",
    )
    assert r.status_code == 400
    assert "30 минут" in r.json()["error"]


@pytest.mark.django_db
def test_backfill_too_late_rejected(client, op, op_user, att_settings):
    log = _make_yesterday_auto_closed_log(op)
    # Пытаемся ввести уход через 15 часов — за верхней границей (14).
    too_late = log.checked_in_at + dt.timedelta(hours=15)
    client.force_authenticate(op_user)
    r = client.post(
        "/api/attendance/me/backfill-checkout/",
        data={"log_id": log.id, "checked_out_at": too_late.isoformat()},
        format="json",
    )
    assert r.status_code == 400
    assert "14 часов" in r.json()["error"]


@pytest.mark.django_db
def test_backfill_after_auto_close_rejected(client, op, op_user, att_settings):
    """
    Нельзя ввести время ухода позже, чем cron уже auto-close'нул смену.
    Логика: если ты был на смене ПОСЛЕ 23:00, cron не должен был закрыть —
    это конфликт данных.
    """
    log = _make_yesterday_auto_closed_log(op)
    later_than_autoclose = log.checked_out_at + dt.timedelta(hours=1)
    client.force_authenticate(op_user)
    r = client.post(
        "/api/attendance/me/backfill-checkout/",
        data={"log_id": log.id, "checked_out_at": later_than_autoclose.isoformat()},
        format="json",
    )
    assert r.status_code == 400


@pytest.mark.django_db
def test_backfill_someone_elses_log_forbidden(
    client, op, op_user, other_op, att_settings
):
    log = _make_yesterday_auto_closed_log(other_op)
    real = log.checked_in_at + dt.timedelta(hours=8)
    client.force_authenticate(op_user)
    r = client.post(
        "/api/attendance/me/backfill-checkout/",
        data={"log_id": log.id, "checked_out_at": real.isoformat()},
        format="json",
    )
    assert r.status_code == 403


@pytest.mark.django_db
def test_backfill_cannot_be_done_twice(client, op, op_user, att_settings, manager_user):
    log = _make_yesterday_auto_closed_log(op)
    real = log.checked_in_at + dt.timedelta(hours=8)
    client.force_authenticate(op_user)
    r1 = client.post(
        "/api/attendance/me/backfill-checkout/",
        data={"log_id": log.id, "checked_out_at": real.isoformat()},
        format="json",
    )
    assert r1.status_code == 200
    r2 = client.post(
        "/api/attendance/me/backfill-checkout/",
        data={"log_id": log.id, "checked_out_at": real.isoformat()},
        format="json",
    )
    assert r2.status_code == 400
    assert "уже подтверждён" in r2.json()["error"]


@pytest.mark.django_db
def test_backfill_rejected_for_non_auto_closed(client, op, op_user, att_settings):
    """
    Manually закрытая смена (или закрытая через обычный /checkout) —
    backfill не имеет смысла и должен быть отклонён.
    """
    log = AttendanceLog.objects.create(
        operator=op,
        checked_in_at=timezone.now() - dt.timedelta(hours=8),
        checked_out_at=timezone.now(),
        auto_closed=False,  # обычное закрытие
    )
    client.force_authenticate(op_user)
    r = client.post(
        "/api/attendance/me/backfill-checkout/",
        data={
            "log_id": log.id,
            "checked_out_at": (log.checked_in_at + dt.timedelta(hours=6)).isoformat(),
        },
        format="json",
    )
    assert r.status_code == 400
    assert "автоматически" in r.json()["error"]


@pytest.mark.django_db
def test_backfill_reduces_forgotten_count(client, op, op_user, att_settings):
    """
    До backfill'a forgotten_count = 1. После — 0. Именно этот эффект
    используется на менеджерской странице (колонка «Забыл выйти: N»).
    """
    log = _make_yesterday_auto_closed_log(op)
    assert forgotten_checkouts_count(op) == 1

    real = log.checked_in_at + dt.timedelta(hours=8)
    client.force_authenticate(op_user)
    r = client.post(
        "/api/attendance/me/backfill-checkout/",
        data={"log_id": log.id, "checked_out_at": real.isoformat()},
        format="json",
    )
    assert r.status_code == 200
    assert forgotten_checkouts_count(op) == 0

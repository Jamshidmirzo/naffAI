"""
Tests for `attendance_checkout_reminder` cron (enforcement wave 2026-08-26).

Проверяем:
  - reminder не шлётся до истечения порога (< N часов);
  - reminder шлётся один раз (второй запуск игнорирует);
  - reminder не шлётся закрытому логу;
  - Notification создаётся с корректным metadata.kind;
  - `checkout_reminder_after_hours=0` полностью выключает cron.
"""

from __future__ import annotations

import datetime as dt

import pytest
from django.contrib.auth import get_user_model
from django.core.management import call_command
from django.utils import timezone

from apps.attendance.models import AttendanceLog, AttendanceSettings
from apps.notifications.models import Notification
from apps.operators.models import Operator
from apps.users.models import Profile, Role

User = get_user_model()


@pytest.fixture
def operator(db):
    # require_checkin_enabled=True — иначе cron сознательно пропускает
    # оператора (см. фильтр в attendance_checkout_reminder.handle).
    return Operator.objects.create(
        full_name="Кассирша Test",
        status="active",
        require_checkin_enabled=True,
    )


@pytest.fixture
def operator_user(db, operator):
    user = User.objects.create_user(username="op_reminder", password="x")
    Profile.objects.create(user=user, role=Role.OPERATOR, operator=operator)
    return user


@pytest.fixture
def settings_obj(db):
    obj, _ = AttendanceSettings.objects.get_or_create(pk=1)
    obj.checkout_reminder_after_hours = 8
    obj.save()
    return obj


@pytest.mark.django_db
def test_reminder_not_sent_before_threshold(operator, operator_user, settings_obj):
    """Смена длится 3 часа — reminder не должен уйти."""
    log = AttendanceLog.objects.create(
        operator=operator,
        checked_in_at=timezone.now() - dt.timedelta(hours=3),
    )
    call_command("attendance_checkout_reminder")
    log.refresh_from_db()
    assert log.checkout_reminder_sent_at is None
    assert Notification.objects.count() == 0


@pytest.mark.django_db
def test_reminder_sent_once_and_only_once(operator, operator_user, settings_obj):
    """
    Смена длится 9 часов — reminder уходит. Второй запуск cron видит
    `checkout_reminder_sent_at` и пропускает.
    """
    log = AttendanceLog.objects.create(
        operator=operator,
        checked_in_at=timezone.now() - dt.timedelta(hours=9),
    )
    call_command("attendance_checkout_reminder")
    log.refresh_from_db()
    assert log.checkout_reminder_sent_at is not None
    notifs_after_first = Notification.objects.filter(recipient=operator_user).count()
    assert notifs_after_first == 1
    assert (
        Notification.objects.filter(recipient=operator_user)
        .first()
        .metadata.get("kind")
        == "attendance_checkout_reminder"
    )

    # Second run — nothing new
    call_command("attendance_checkout_reminder")
    assert (
        Notification.objects.filter(recipient=operator_user).count()
        == notifs_after_first
    )


@pytest.mark.django_db
def test_reminder_skips_closed_logs(operator, operator_user, settings_obj):
    """Уже закрытая смена — не должна получать reminder."""
    log = AttendanceLog.objects.create(
        operator=operator,
        checked_in_at=timezone.now() - dt.timedelta(hours=10),
        checked_out_at=timezone.now(),
    )
    call_command("attendance_checkout_reminder")
    log.refresh_from_db()
    assert log.checkout_reminder_sent_at is None
    assert Notification.objects.count() == 0


@pytest.mark.django_db
def test_reminder_disabled_when_hours_zero(operator, operator_user, settings_obj):
    """`checkout_reminder_after_hours=0` → cron ничего не делает."""
    settings_obj.checkout_reminder_after_hours = 0
    settings_obj.save()
    AttendanceLog.objects.create(
        operator=operator,
        checked_in_at=timezone.now() - dt.timedelta(hours=20),
    )
    call_command("attendance_checkout_reminder")
    assert Notification.objects.count() == 0


@pytest.mark.django_db
def test_reminder_notification_has_link_to_my(operator, operator_user, settings_obj):
    """Проверяем, что link=/my — фронт откроет операторскую страницу."""
    AttendanceLog.objects.create(
        operator=operator,
        checked_in_at=timezone.now() - dt.timedelta(hours=9),
    )
    call_command("attendance_checkout_reminder")
    n = Notification.objects.get()
    assert n.link == "/my"
    assert n.metadata.get("log_id") is not None


@pytest.mark.django_db
def test_reminder_rollback_when_no_recipient(operator, settings_obj):
    """
    У оператора нет привязанного User (operator_user fixture НЕ создан)
    → Notification не создаётся, TG тоже недоступен → cron должен
    откатить `checkout_reminder_sent_at`, чтобы следующий tick попробовал.
    """
    log = AttendanceLog.objects.create(
        operator=operator,
        checked_in_at=timezone.now() - dt.timedelta(hours=9),
    )
    call_command("attendance_checkout_reminder")
    log.refresh_from_db()
    assert log.checkout_reminder_sent_at is None
    assert Notification.objects.count() == 0


@pytest.mark.django_db
def test_reminder_skips_operators_without_opt_in(db, settings_obj):
    """
    Оператор без `require_checkin_enabled=True` — reminder не идёт.
    Это защита rollout'a: prod-операторы (все False по умолчанию) не
    получают неожиданный новый DM. Long-shift-warning с порогом 10ч
    их обслуживает по-старому.
    """
    op = Operator.objects.create(
        full_name="Prod Op", status="active", require_checkin_enabled=False
    )
    op_user = User.objects.create_user(username="prod_op", password="x")
    Profile.objects.create(user=op_user, role=Role.OPERATOR, operator=op)

    log = AttendanceLog.objects.create(
        operator=op,
        checked_in_at=timezone.now() - dt.timedelta(hours=12),
    )
    call_command("attendance_checkout_reminder")
    log.refresh_from_db()
    assert log.checkout_reminder_sent_at is None
    assert Notification.objects.count() == 0

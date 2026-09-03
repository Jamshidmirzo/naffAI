"""
Тесты для двух новых cron'ов уведомлений оператору:

  1. `attendance_late_notification` — «вы опоздали сегодня» для смен с
     `was_late=True`; идемпотентно через `late_notified_at`.
  2. `attendance_nine_hour_notification` — «пора закрыть смену» через
     N часов от check-in; идемпотентно через `nine_hour_notified_at`;
     не шлёт после `shift_end + 3h` (ночью не будим).

Оба команды уважают глобальный `enforce_daily_checkin`; при выключенном
глобально — уведомляем только операторов с per-op флагом
`require_checkin_enabled=True`.
"""

from __future__ import annotations

import datetime as dt
from io import StringIO

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
def op(db):
    return Operator.objects.create(full_name="Late Op", status="active")


@pytest.fixture
def op_user(db, op):
    u = User.objects.create_user(username="op_late", password="x")
    Profile.objects.create(user=u, role=Role.OPERATOR, operator=op)
    return u


def _settings(**kwargs):
    s, _ = AttendanceSettings.objects.get_or_create(pk=1)
    for k, v in kwargs.items():
        setattr(s, k, v)
    s.save()
    return s


# ---- late_notification --------------------------------------------------


@pytest.mark.django_db
def test_late_notif_sends_when_was_late(op, op_user):
    """При was_late=True + late_notified_at=None → нотификация.

    Дефолт глобальный: enforce_daily_checkin=True, тумблер уже влияет
    на всех операторов сразу."""
    _settings(shift_start=dt.time(10, 0), late_threshold_min=15)
    now = timezone.now()
    log = AttendanceLog.objects.create(
        operator=op,
        checked_in_at=now,
        was_late=True,
    )

    call_command("attendance_late_notification", stdout=StringIO())

    log.refresh_from_db()
    assert log.late_notified_at is not None
    notifs = Notification.objects.filter(recipient=op_user)
    assert notifs.count() == 1
    n = notifs.first()
    assert n.metadata.get("kind") == "attendance_late"
    assert n.metadata.get("log_id") == log.id


@pytest.mark.django_db
def test_late_notif_idempotent(op, op_user):
    """Второй запуск не создаёт дубликат."""
    _settings(shift_start=dt.time(10, 0), late_threshold_min=15)
    now = timezone.now()
    AttendanceLog.objects.create(operator=op, checked_in_at=now, was_late=True)

    call_command("attendance_late_notification", stdout=StringIO())
    call_command("attendance_late_notification", stdout=StringIO())

    assert Notification.objects.filter(recipient=op_user).count() == 1


@pytest.mark.django_db
def test_late_notif_skips_when_not_late(op, op_user):
    """was_late=False → тишина."""
    now = timezone.now()
    AttendanceLog.objects.create(operator=op, checked_in_at=now, was_late=False)
    call_command("attendance_late_notification", stdout=StringIO())
    assert Notification.objects.count() == 0


@pytest.mark.django_db
def test_late_notif_dry_run_no_side_effects(op, op_user):
    AttendanceLog.objects.create(
        operator=op, checked_in_at=timezone.now(), was_late=True
    )
    out = StringIO()
    call_command("attendance_late_notification", "--dry-run", stdout=out)
    assert AttendanceLog.objects.filter(late_notified_at__isnull=False).count() == 0
    assert Notification.objects.count() == 0


@pytest.mark.django_db
def test_late_notif_global_off_needs_per_op_flag(op, op_user):
    """Global enforce off → уведомляем только per-op включённых."""
    _settings(enforce_daily_checkin=False)
    AttendanceLog.objects.create(
        operator=op, checked_in_at=timezone.now(), was_late=True
    )
    call_command("attendance_late_notification", stdout=StringIO())
    assert Notification.objects.count() == 0

    op.require_checkin_enabled = True
    op.save(update_fields=["require_checkin_enabled"])
    call_command("attendance_late_notification", stdout=StringIO())
    assert Notification.objects.count() == 1


# ---- nine_hour_notification --------------------------------------------


@pytest.mark.django_db
def test_nine_hour_notif_sends_when_open_and_over_threshold(op, op_user):
    """Открытая смена > 9ч → notif."""
    _settings(
        shift_start=dt.time(10, 0),
        shift_end=dt.time(23, 30),  # чтобы now < shift_end+3ч
        nine_hour_reminder_hours=9,
    )
    log = AttendanceLog.objects.create(
        operator=op,
        checked_in_at=timezone.now() - dt.timedelta(hours=10),
    )

    call_command("attendance_nine_hour_notification", stdout=StringIO())

    log.refresh_from_db()
    assert log.nine_hour_notified_at is not None
    notifs = Notification.objects.filter(recipient=op_user)
    assert notifs.count() == 1
    assert notifs.first().metadata.get("kind") == "attendance_shift_9h"


@pytest.mark.django_db
def test_nine_hour_notif_skips_closed_log(op, op_user):
    _settings(nine_hour_reminder_hours=9, shift_end=dt.time(23, 30))
    AttendanceLog.objects.create(
        operator=op,
        checked_in_at=timezone.now() - dt.timedelta(hours=10),
        checked_out_at=timezone.now(),
    )
    call_command("attendance_nine_hour_notification", stdout=StringIO())
    assert Notification.objects.count() == 0


@pytest.mark.django_db
def test_nine_hour_notif_skips_when_under_threshold(op, op_user):
    _settings(nine_hour_reminder_hours=9, shift_end=dt.time(23, 30))
    AttendanceLog.objects.create(
        operator=op, checked_in_at=timezone.now() - dt.timedelta(hours=5)
    )
    call_command("attendance_nine_hour_notification", stdout=StringIO())
    assert Notification.objects.count() == 0


@pytest.mark.django_db
def test_nine_hour_notif_idempotent(op, op_user):
    _settings(nine_hour_reminder_hours=9, shift_end=dt.time(23, 30))
    AttendanceLog.objects.create(
        operator=op, checked_in_at=timezone.now() - dt.timedelta(hours=10)
    )
    call_command("attendance_nine_hour_notification", stdout=StringIO())
    call_command("attendance_nine_hour_notification", stdout=StringIO())
    assert Notification.objects.filter(recipient=op_user).count() == 1


@pytest.mark.django_db
def test_nine_hour_notif_disabled_when_hours_zero(op, op_user):
    _settings(nine_hour_reminder_hours=0)
    AttendanceLog.objects.create(
        operator=op, checked_in_at=timezone.now() - dt.timedelta(hours=10)
    )
    call_command("attendance_nine_hour_notification", stdout=StringIO())
    assert Notification.objects.count() == 0


@pytest.mark.django_db
def test_nine_hour_notif_dry_run_no_side_effects(op, op_user):
    _settings(nine_hour_reminder_hours=9, shift_end=dt.time(23, 30))
    AttendanceLog.objects.create(
        operator=op, checked_in_at=timezone.now() - dt.timedelta(hours=10)
    )
    out = StringIO()
    call_command("attendance_nine_hour_notification", "--dry-run", stdout=out)
    assert (
        AttendanceLog.objects.filter(nine_hour_notified_at__isnull=False).count()
        == 0
    )
    assert Notification.objects.count() == 0

import pytest
import datetime as dt
from django.utils import timezone
from django.test import override_settings
from unittest.mock import AsyncMock, patch
from freezegun import freeze_time

from apps.operators.models import Operator
from apps.users.models import Profile, Role
from apps.attendance.models import AttendanceLog, AttendanceSettings
from apps.attendance.services import operator_qr_rotate, qr_token_build, attendance_scan
from apps.tg_bot.runner import (
    _bot_attendance_checkin,
    _bot_attendance_checkout,
    _bot_attendance_status,
)


@pytest.fixture
def operator(db):
    return Operator.objects.create(full_name="ТГ Оператор", status="active")


@pytest.fixture
def user(db, operator):
    from django.contrib.auth import get_user_model
    User = get_user_model()
    u = User.objects.create_user(username="tgop", password="x")
    Profile.objects.create(
        user=u,
        role=Role.OPERATOR,
        operator=operator,
        telegram_user_id=123456,
    )
    return u


@pytest.mark.django_db
def test_tg_checkin_creates_log(operator, user):
    tz = timezone.get_current_timezone()
    base_time = dt.datetime(2026, 7, 24, 10, 5, 0, tzinfo=tz)

    with freeze_time(base_time):
        res = _bot_attendance_checkin(123456, "tgopusername")

    assert "Отмечен приход в 10:05" in res
    assert AttendanceLog.objects.filter(operator=operator).count() == 1
    log = AttendanceLog.objects.get(operator=operator)
    assert log.source == "tg"
    assert log.checked_in_ip is None


@pytest.mark.django_db
def test_tg_checkin_not_linked(db):
    res = _bot_attendance_checkin(99999, "unknown")
    assert "Сначала привяжите аккаунт: /link_operator" in res
    assert AttendanceLog.objects.count() == 0


@pytest.mark.django_db
def test_tg_checkout_closes_log(operator, user):
    tz = timezone.get_current_timezone()
    base_time = dt.datetime(2026, 7, 24, 10, 5, 0, tzinfo=tz)

    with freeze_time(base_time):
        _bot_attendance_checkin(123456, "tgopusername")

    # Move 30 minutes forward
    future_time = base_time + dt.timedelta(minutes=30)
    with freeze_time(future_time):
        res = _bot_attendance_checkout(123456, "tgopusername")

    assert "Смена: 10:05–10:35 (30 мин)" in res
    log = AttendanceLog.objects.get(operator=operator)
    assert log.checked_out_at is not None


@pytest.mark.django_db
def test_tg_checkout_without_log(operator, user):
    res = _bot_attendance_checkout(123456, "tgopusername")
    assert "Вы сегодня не отмечались" in res


@pytest.mark.django_db
def test_tg_disabled_by_settings(operator, user):
    settings = AttendanceSettings.objects.get_or_create(pk=1)[0]
    settings.tg_checkin_enabled = False
    settings.save()

    res = _bot_attendance_checkin(123456, "tgopusername")
    assert "Отметка через Telegram отключена" in res
    assert AttendanceLog.objects.count() == 0


@pytest.mark.django_db
@override_settings(ATTENDANCE_SCAN_COOLDOWN_SECONDS=30)
def test_tg_rate_limit_shared_with_http(operator, user):
    qr = operator_qr_rotate(operator=operator, actor=user)
    token = qr_token_build(operator, qr.nonce)

    # Check-in via HTTP QR Scan first
    attendance_scan(qr_raw=token, ip="127.0.0.1", user_agent="Mozilla")

    # Try check-out via Telegram immediately (within 30 seconds)
    res = _bot_attendance_checkout(123456, "tgopusername")
    assert "Подождите 30 секунд" in res


@pytest.mark.django_db
def test_tg_status_command(operator, user):
    tz = timezone.get_current_timezone()
    base_time = dt.datetime(2026, 7, 24, 10, 5, 0, tzinfo=tz)

    with freeze_time(base_time):
        res = _bot_attendance_status(123456)
        assert "Вы не на смене." in res

        _bot_attendance_checkin(123456, "tgopusername")

    future_time = base_time + dt.timedelta(hours=2, minutes=15)
    with freeze_time(future_time):
        res2 = _bot_attendance_status(123456)
        assert "Вы на смене с 10:05, работаете 2ч 15мин" in res2

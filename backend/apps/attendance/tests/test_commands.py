import pytest
import datetime as dt
from django.core.management import call_command
from django.utils import timezone
from unittest.mock import patch, AsyncMock

from apps.operators.models import Operator
from apps.users.models import Profile, Role
from apps.attendance.models import OperatorQr, AttendanceLog
from apps.attendance.services import qr_token_build, operator_qr_rotate, attendance_scan


@pytest.fixture
def operator(db):
    return Operator.objects.create(full_name="Командный Оператор", status="active")


@pytest.fixture
def user(db, operator):
    from django.contrib.auth import get_user_model
    User = get_user_model()
    u = User.objects.create_user(username="cmdop", password="x")
    Profile.objects.create(user=u, role=Role.OPERATOR, operator=operator)
    return u


@pytest.mark.django_db
def test_command_auto_close(operator, user):
    qr = operator_qr_rotate(operator=operator, actor=user)
    token = qr_token_build(operator, qr.nonce)
    attendance_scan(qr_raw=token, ip="127.0.0.1", user_agent="Mozilla")

    # Log is open
    log = AttendanceLog.objects.get(operator=operator)
    assert log.checked_out_at is None

    # Call dry-run first
    call_command("attendance_auto_close", dry_run=True)
    log.refresh_from_db()
    assert log.checked_out_at is None

    # Call actual run
    call_command("attendance_auto_close")
    log.refresh_from_db()
    assert log.checked_out_at is not None
    assert log.auto_closed is True


@pytest.mark.django_db
def test_command_backfill_operator_qrs(operator):
    # Verify no QRs
    assert OperatorQr.objects.filter(operator=operator).count() == 0

    # Backfill
    call_command("backfill_operator_qrs")
    assert OperatorQr.objects.filter(operator=operator, revoked_at__isnull=True).count() == 1
    qr1 = OperatorQr.objects.get(operator=operator)

    # Backfill again without force (should not create new)
    call_command("backfill_operator_qrs")
    assert OperatorQr.objects.filter(operator=operator, revoked_at__isnull=True).count() == 1
    assert OperatorQr.objects.get(operator=operator).id == qr1.id

    # Backfill with force (rotates QR)
    call_command("backfill_operator_qrs", force=True)
    assert OperatorQr.objects.filter(operator=operator, revoked_at__isnull=True).count() == 1
    qr1.refresh_from_db()
    assert qr1.revoked_at is not None


@pytest.mark.django_db
@patch("aiogram.Bot")
def test_command_morning_report(mock_bot_class, operator):
    from django.contrib.auth import get_user_model
    User = get_user_model()
    # Create Team Lead
    tl_user = User.objects.create_user(username="tl_user", password="x")
    Profile.objects.create(user=tl_user, role=Role.TEAM_LEAD, telegram_user_id=12345)

    mock_bot = AsyncMock()
    mock_bot_class.return_value = mock_bot

    with patch("django.conf.settings.TELEGRAM_BOT_TOKEN", "fake-token"):
        call_command("attendance_morning_report")

    # Verify bot sent a message
    mock_bot.send_message.assert_called_once()
    assert mock_bot.send_message.call_args[0][0] == 12345
    assert "Отчёт по посещаемости" in mock_bot.send_message.call_args[0][1]

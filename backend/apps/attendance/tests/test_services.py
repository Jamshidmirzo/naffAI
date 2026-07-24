import pytest
import datetime as dt
from django.utils import timezone
from django.core.exceptions import ValidationError, PermissionDenied
from django.contrib.auth import get_user_model
from django.test import override_settings
from rest_framework.authtoken.models import Token
from freezegun import freeze_time

from apps.operators.models import Operator
from apps.users.models import Profile, Role
from apps.attendance.models import OperatorQr, AttendanceLog, AttendanceSettings
from apps.attendance.services import (
    qr_token_build,
    qr_token_verify,
    operator_qr_rotate,
    attendance_scan,
    process_attendance_event,
    auto_close_open_logs,
    QrRevokedError,
    ScanRateLimitError,
    IpNotAllowedError,
)
from apps.attendance.selectors import attendance_report

User = get_user_model()


@pytest.fixture
def operator(db):
    return Operator.objects.create(full_name="Тест Оператор", status="active")


@pytest.fixture
def user(db, operator):
    u = User.objects.create_user(username="testop", password="x")
    Profile.objects.create(user=u, role=Role.OPERATOR, operator=operator)
    return u


@pytest.mark.django_db
def test_qr_signing_roundtrip(operator):
    nonce = "abc123nonce"
    OperatorQr.objects.create(operator=operator, nonce=nonce)
    token = qr_token_build(operator, nonce)

    # Valid verify
    op, qr = qr_token_verify(token)
    assert op.id == operator.id
    assert qr.nonce == nonce

    # Invalid HMAC
    bad_token = token[:-2] + "xx"
    with pytest.raises(ValidationError, match="Неверная подпись"):
        qr_token_verify(bad_token)

    # Invalid prefix
    with pytest.raises(ValidationError, match="Неверный формат"):
        qr_token_verify("badprefix:1:abc123nonce:sig")


@pytest.mark.django_db
def test_operator_qr_rotate(operator, user):
    qr1 = operator_qr_rotate(operator=operator, actor=user)
    assert qr1.nonce is not None
    assert qr1.revoked_at is None

    # Rotate
    qr2 = operator_qr_rotate(operator=operator, actor=user)
    qr1.refresh_from_db()
    assert qr1.revoked_at is not None
    assert qr1.revoked_by == user
    assert qr2.nonce != qr1.nonce

    # Verifying old token raises QrRevokedError
    old_token = qr_token_build(operator, qr1.nonce)
    with pytest.raises(QrRevokedError, match="QR-код отозван"):
        qr_token_verify(old_token)


@pytest.mark.django_db
def test_scan_check_in_out_workflow(operator, user):
    qr = operator_qr_rotate(operator=operator, actor=user)
    token = qr_token_build(operator, qr.nonce)

    tz = timezone.get_current_timezone()
    base_time = dt.datetime(2026, 7, 24, 10, 5, 0, tzinfo=tz)

    with freeze_time(base_time):
        # 1. First scan: check-in
        res = attendance_scan(qr_raw=token, ip="127.0.0.1", user_agent="Mozilla")
        assert res["action"] == "check_in"
        assert res["token"] is not None
        assert res["was_late"] is False

        # Check DB state
        log = AttendanceLog.objects.get(operator=operator)
        assert log.checked_out_at is None
        assert log.token_key == res["token"]
        assert Token.objects.filter(key=log.token_key).exists()

    # Move time forward by 45 minutes to bypass scan cooldown and simulate work duration
    future_time = base_time + dt.timedelta(minutes=45)
    with freeze_time(future_time):
        # 2. Second scan: check-out
        res2 = attendance_scan(qr_raw=token, ip="127.0.0.1", user_agent="Mozilla")
        assert res2["action"] == "check_out"
        assert res2["duration_min"] == 45

        # Check DB state
        log.refresh_from_db()
        assert log.checked_out_at is not None
        assert not Token.objects.filter(key=log.token_key).exists()


@pytest.mark.django_db
@override_settings(ATTENDANCE_SCAN_COOLDOWN_SECONDS=30)
def test_scan_rate_limit(operator, user):
    qr = operator_qr_rotate(operator=operator, actor=user)
    token = qr_token_build(operator, qr.nonce)

    attendance_scan(qr_raw=token, ip="127.0.0.1", user_agent="Mozilla")

    # Scan again immediately
    with pytest.raises(ScanRateLimitError, match="Подождите 30 секунд"):
        attendance_scan(qr_raw=token, ip="127.0.0.1", user_agent="Mozilla")


@pytest.mark.django_db
@override_settings(ATTENDANCE_ALLOWED_NETWORKS=["192.168.1.0/24"])
def test_scan_ip_whitelist(operator, user):
    qr = operator_qr_rotate(operator=operator, actor=user)
    token = qr_token_build(operator, qr.nonce)

    # Non-whitelisted IP
    with pytest.raises(IpNotAllowedError):
        attendance_scan(qr_raw=token, ip="10.0.0.5", user_agent="Mozilla")

    # Whitelisted IP
    res = attendance_scan(qr_raw=token, ip="192.168.1.15", user_agent="Mozilla")
    assert res["action"] == "check_in"


@pytest.mark.django_db
def test_scan_lateness_indicators(operator, user):
    # Set shift start to 10:00, threshold 15 min (late if > 10:15)
    settings = AttendanceSettings.objects.get_or_create(pk=1)[0]
    settings.shift_start = dt.time(10, 0)
    settings.late_threshold_min = 15
    settings.save()

    qr = operator_qr_rotate(operator=operator, actor=user)
    token = qr_token_build(operator, qr.nonce)

    # 1. Checked in at 10:14 local time
    tz = timezone.get_current_timezone()
    dt_1 = dt.datetime(2026, 7, 24, 10, 14, 0, tzinfo=tz)
    with freeze_time(dt_1):
        res1 = attendance_scan(qr_raw=token, ip="127.0.0.1", user_agent="Mozilla")
        assert res1["was_late"] is False

    # Force delete log for next test
    AttendanceLog.objects.all().delete()

    # 2. Checked in at 10:16 local time
    dt_2 = dt.datetime(2026, 7, 24, 10, 16, 0, tzinfo=tz)
    with freeze_time(dt_2):
        res2 = attendance_scan(qr_raw=token, ip="127.0.0.1", user_agent="Mozilla")
        assert res2["was_late"] is True


@pytest.mark.django_db
def test_auto_close_logs(operator, user):
    qr = operator_qr_rotate(operator=operator, actor=user)
    token = qr_token_build(operator, qr.nonce)
    attendance_scan(qr_raw=token, ip="127.0.0.1", user_agent="Mozilla")

    # Log is open
    log = AttendanceLog.objects.get(operator=operator)
    assert log.checked_out_at is None

    # Run auto-close
    close_time = timezone.now() + dt.timedelta(hours=5)
    count = auto_close_open_logs(at=close_time)
    assert count == 1

    log.refresh_from_db()
    assert log.checked_out_at == close_time
    assert log.auto_closed is True
    assert not Token.objects.filter(key=log.token_key).exists()


@pytest.mark.django_db
def test_morning_report_selectors(operator, user):
    qr = operator_qr_rotate(operator=operator, actor=user)
    token = qr_token_build(operator, qr.nonce)

    today = timezone.localdate()
    # Check-in today
    attendance_scan(qr_raw=token, ip="127.0.0.1", user_agent="Mozilla")

    report = attendance_report(today)
    assert report["counts"]["present"] == 1
    assert report["counts"]["absent"] == 0

import pytest
from apps.operators.models import Operator
from apps.users.models import Profile, Role
from apps.audit.models import AuditLog
from apps.attendance.services import operator_qr_rotate, qr_token_build, attendance_scan
from apps.tg_bot.runner import _bot_attendance_checkin


@pytest.fixture
def operator(db):
    return Operator.objects.create(full_name="Аудит Оператор", status="active")


@pytest.fixture
def user(db, operator):
    from django.contrib.auth import get_user_model
    User = get_user_model()
    u = User.objects.create_user(username="auditop", password="x")
    Profile.objects.create(
        user=u,
        role=Role.OPERATOR,
        operator=operator,
        telegram_user_id=88888,
    )
    return u


@pytest.mark.django_db
def test_audit_no_secret_leak(operator, user):
    qr = operator_qr_rotate(operator=operator, actor=user)
    token = qr_token_build(operator, qr.nonce)

    # 1. Trigger rotate and scan
    attendance_scan(qr_raw=token, ip="127.0.0.1", user_agent="Mozilla")

    # Fetch logs
    logs = AuditLog.objects.all()
    assert logs.count() > 0

    sensitive_keywords = ["qr_payload", "token_key", "hmac", "password", "secret", "token"]
    for l in logs:
        changes_str = str(l.changes or "").lower()
        comment_str = str(l.comment or "").lower()

        # Verify no raw secrets/keys leaked
        for keyword in sensitive_keywords:
            # Check if key name is present in changes, it should be redacted
            if keyword in changes_str:
                assert "<redacted>" in changes_str
            # The hmac or key value itself should not be present
            assert "test-hmac-key" not in changes_str
            assert "test-hmac-key" not in comment_str


@pytest.mark.django_db
def test_audit_source_recorded(operator, user):
    qr = operator_qr_rotate(operator=operator, actor=user)
    token = qr_token_build(operator, qr.nonce)

    # Check in via QR
    attendance_scan(qr_raw=token, ip="127.0.0.1", user_agent="Mozilla")
    log_qr = AuditLog.objects.filter(action="attendance.scan_ok").latest("id")
    assert log_qr.changes["source"] == "qr"
    assert log_qr.changes["initiator"] == "ip=127.0.0.1"

    # Force delete logs to prevent cooldown block
    from apps.attendance.models import AttendanceLog
    AttendanceLog.objects.all().delete()

    # Check in via Telegram
    _bot_attendance_checkin(88888, "auditopusername")
    log_tg = AuditLog.objects.filter(action="attendance.scan_ok").latest("id")
    assert log_tg.changes["source"] == "tg"
    assert "tg=@auditopusername" in log_tg.changes["initiator"]

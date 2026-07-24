import pytest
from apps.operators.models import Operator
from apps.users.models import Profile, Role
from apps.attendance.models import AttendanceLog, AttendanceSettings
from apps.attendance.services import process_attendance_event
from apps.audit.models import AuditLog
from django.contrib.auth import get_user_model

User = get_user_model()

@pytest.fixture
def settings_obj(db):
    return AttendanceSettings.objects.get_or_create(pk=1)[0]

@pytest.mark.django_db
def test_shared_workstation_replaces_previous_session(settings_obj):
    user_a = User.objects.create_user(username="operator_a", password="123")
    user_b = User.objects.create_user(username="operator_b", password="123")
    
    op_a = Operator.objects.create(full_name="Operator A")
    op_b = Operator.objects.create(full_name="Operator B")
    
    Profile.objects.create(user=user_a, operator=op_a, role=Role.OPERATOR)
    Profile.objects.create(user=user_b, operator=op_b, role=Role.OPERATOR)

    ip = "192.168.1.100"
    user_agent = "Mozilla/5.0"
    
    # Check-in Operator A
    process_attendance_event(
        operator=op_a,
        source="qr",
        initiator="test_qr_1",
        ip=ip,
        user_agent=user_agent,
        issue_token=True,
    )
    
    log_a = AttendanceLog.objects.get(operator=op_a)
    assert log_a.checked_out_at is None
    assert not log_a.auto_closed
    
    # Check-in Operator B on the same terminal
    process_attendance_event(
        operator=op_b,
        source="qr",
        initiator="test_qr_2",
        ip=ip,
        user_agent=user_agent,
        issue_token=True,
    )
    
    # Assert Operator A's log is now closed
    log_a.refresh_from_db()
    assert log_a.checked_out_at is not None
    assert log_a.auto_closed is True
    
    # Assert Operator B has an open log
    log_b = AttendanceLog.objects.get(operator=op_b, checked_out_at__isnull=True)
    assert log_b is not None
    
    # Assert AuditLog entry exists
    audit = AuditLog.objects.filter(action="attendance.stale_session_closed").first()
    assert audit is not None
    assert audit.entity_id == str(log_a.id)

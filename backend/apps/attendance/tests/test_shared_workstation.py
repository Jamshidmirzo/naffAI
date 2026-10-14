"""
Forgotten sessions on a shared device (same IP + user agent).

2026-10-14: in the office every phone is behind one NAT IP and many have the
same browser, so "same IP + UA" is not "same device". A colleague's shift
from *today* is never closed by someone else's scan; a forgotten session from
a previous day still is.
"""

import datetime as dt

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone

from apps.attendance.models import AttendanceLog, AttendanceSettings
from apps.attendance.services import process_attendance_event
from apps.audit.models import AuditLog
from apps.operators.models import Operator
from apps.users.models import Profile, Role

User = get_user_model()

IP = "192.168.1.100"
UA = "Mozilla/5.0"


@pytest.fixture
def settings_obj(db):
    return AttendanceSettings.objects.get_or_create(pk=1)[0]


def _op(name: str) -> Operator:
    op = Operator.objects.create(full_name=name)
    user = User.objects.create_user(username=name.lower().replace(" ", "_"), password="123")
    Profile.objects.create(user=user, operator=op, role=Role.OPERATOR)
    return op


def _scan(op: Operator) -> None:
    process_attendance_event(operator=op, source="qr", initiator="test_qr", ip=IP, user_agent=UA, issue_token=True)


@pytest.mark.django_db
def test_colleague_shift_from_today_stays_open(settings_obj):
    op_a, op_b = _op("Operator A"), _op("Operator B")
    _scan(op_a)
    log_a = AttendanceLog.objects.get(operator=op_a)
    # A checked in 4 hours ago from the same office network and browser.
    log_a.checked_in_at = timezone.now() - dt.timedelta(hours=4)
    log_a.save(update_fields=["checked_in_at"])

    _scan(op_b)

    log_a.refresh_from_db()
    assert log_a.checked_out_at is None
    assert not log_a.auto_closed
    assert AttendanceLog.objects.filter(operator=op_b, checked_out_at__isnull=True).exists()
    assert not AuditLog.objects.filter(action="attendance.stale_session_closed").exists()


@pytest.mark.django_db
def test_forgotten_session_from_yesterday_is_closed(settings_obj):
    op_a, op_b = _op("Operator A"), _op("Operator B")
    _scan(op_a)
    log_a = AttendanceLog.objects.get(operator=op_a)
    log_a.checked_in_at = timezone.now() - dt.timedelta(days=1)
    log_a.save(update_fields=["checked_in_at"])

    _scan(op_b)

    log_a.refresh_from_db()
    assert log_a.checked_out_at is not None
    assert log_a.auto_closed is True
    audit = AuditLog.objects.filter(action="attendance.stale_session_closed").first()
    assert audit is not None and audit.entity_id == str(log_a.id)

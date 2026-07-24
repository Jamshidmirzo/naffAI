import datetime as dt

import pytest
from django.contrib.auth import get_user_model
from django.core.management import call_command
from django.utils import timezone
from unittest.mock import patch

from apps.attendance.models import AttendanceLog
from apps.audit.models import AuditLog
from apps.operators.models import Operator
from apps.users.models import Profile, Role

User = get_user_model()


@pytest.fixture
def operator(db):
    return Operator.objects.create(full_name="Test", status="active")


@pytest.fixture
def user_op(db, operator):
    u = User.objects.create_user(username="user_op", password="x")
    Profile.objects.create(
        user=u, role=Role.OPERATOR, operator=operator, telegram_user_id=11111
    )
    return u


@pytest.fixture
def user_tl(db):
    u = User.objects.create_user(username="user_tl", password="x")
    Profile.objects.create(
        user=u, role=Role.TEAM_LEAD, telegram_user_id=22222
    )
    return u


@pytest.mark.django_db
@patch(
    "apps.attendance.management.commands.attendance_long_shift_check.send_long_shift_warning_dms"
)
def test_long_shift_warning_dm_total_failure_rolls_back_flag(
    mock_send, user_op, user_tl, operator
):
    """
    P0: If TG-send fails for everyone, the `long_shift_warning_sent_at`
    flag must be rolled back so the next timer run retries — no silent
    "flagged as sent but never delivered".
    """

    async def _empty(*args, **kwargs):
        return []

    mock_send.side_effect = _empty

    log = AttendanceLog.objects.create(
        operator=operator,
        checked_in_at=timezone.now() - dt.timedelta(hours=11),
    )

    call_command("attendance_long_shift_check")

    log.refresh_from_db()
    assert log.long_shift_warning_sent_at is None, (
        "flag must be rolled back when nobody actually received the DM"
    )
    assert not AuditLog.objects.filter(
        entity="AttendanceLog",
        entity_id=str(log.id),
    ).filter(action__icontains="warning_sent").exists()


@pytest.mark.django_db
@patch(
    "apps.attendance.management.commands.attendance_long_shift_check.send_long_shift_warning_dms"
)
def test_long_shift_warning_partial_success_keeps_flag(
    mock_send, user_op, user_tl, operator
):
    """Even one successful recipient counts — flag stays, audit written."""

    async def _ok(*args, **kwargs):
        return ["operator"]

    mock_send.side_effect = _ok

    log = AttendanceLog.objects.create(
        operator=operator,
        checked_in_at=timezone.now() - dt.timedelta(hours=11),
    )

    call_command("attendance_long_shift_check")

    log.refresh_from_db()
    assert log.long_shift_warning_sent_at is not None

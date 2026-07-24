import pytest
import datetime as dt
from django.utils import timezone
from django.contrib.auth import get_user_model
from django.core.management import call_command
from django.test import override_settings
from rest_framework.test import APIClient
from unittest.mock import patch, AsyncMock

from apps.operators.models import Operator
from apps.users.models import Profile, Role
from apps.attendance.models import AttendanceLog, AttendanceSettings
from apps.attendance.services import operator_qr_rotate, qr_token_build, attendance_scan
from apps.audit.models import AuditLog
from apps.tg_bot.runner import _bot_auto_checkout_confirm, _bot_continue_working

User = get_user_model()


@pytest.fixture
def api_client():
    return APIClient()


@pytest.fixture
def operator(db):
    return Operator.objects.create(full_name="Тест Оператор", status="active")


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
    Profile.objects.create(user=u, role=Role.TEAM_LEAD, telegram_user_id=22222)
    return u


@pytest.mark.django_db
@patch(
    "apps.attendance.management.commands.attendance_long_shift_check.send_long_shift_warning_dms",
    new_callable=AsyncMock,
)
def test_long_shift_warning_command_sends_dms(mock_send, operator, user_op, user_tl):
    mock_send.return_value = ["operator", "team_lead"]
    settings = AttendanceSettings.objects.get_or_create(pk=1)[0]
    settings.long_shift_warning_hours = 10
    settings.save()

    checked_in = timezone.now() - dt.timedelta(hours=11)
    log = AttendanceLog.objects.create(operator=operator, checked_in_at=checked_in)

    call_command("attendance_long_shift_check")

    log.refresh_from_db()
    assert log.long_shift_warning_sent_at is not None
    mock_send.assert_called_once_with(
        operator_tg_id=11111,
        tl_tg_id=22222,
        log_id=log.id,
        operator_name="Тест Оператор",
        hours=10,
    )
    assert AuditLog.objects.filter(action="attendance.long_shift_warning_sent").exists()


@pytest.mark.django_db
@patch(
    "apps.attendance.management.commands.attendance_long_shift_check.send_long_shift_warning_dms",
    new_callable=AsyncMock,
)
def test_long_shift_warning_not_re_sent(mock_send, operator, user_op, user_tl):
    mock_send.return_value = ["operator", "team_lead"]
    checked_in = timezone.now() - dt.timedelta(hours=11)
    log = AttendanceLog.objects.create(
        operator=operator,
        checked_in_at=checked_in,
        long_shift_warning_sent_at=timezone.now(),
    )

    call_command("attendance_long_shift_check")
    mock_send.assert_not_called()


@pytest.mark.django_db
@patch(
    "apps.attendance.management.commands.attendance_long_shift_check.send_long_shift_warning_dms",
    new_callable=AsyncMock,
)
def test_long_shift_warning_no_tg_operator_notifies_tl_only(
    mock_send, operator, user_op, user_tl
):
    op_profile = user_op.profile
    op_profile.telegram_user_id = None
    op_profile.save()

    mock_send.return_value = ["team_lead"]
    checked_in = timezone.now() - dt.timedelta(hours=11)
    log = AttendanceLog.objects.create(operator=operator, checked_in_at=checked_in)

    call_command("attendance_long_shift_check")
    mock_send.assert_called_once_with(
        operator_tg_id=None,
        tl_tg_id=22222,
        log_id=log.id,
        operator_name="Тест Оператор",
        hours=10,
    )


@pytest.mark.django_db
@patch(
    "apps.attendance.management.commands.attendance_long_shift_check.send_long_shift_warning_dms",
    new_callable=AsyncMock,
)
def test_long_shift_warning_no_tl_notifies_operator_only(mock_send, operator, user_op, user_tl):
    user_tl.profile.delete()

    mock_send.return_value = ["operator"]
    checked_in = timezone.now() - dt.timedelta(hours=11)
    log = AttendanceLog.objects.create(operator=operator, checked_in_at=checked_in)

    call_command("attendance_long_shift_check")
    mock_send.assert_called_once_with(
        operator_tg_id=11111,
        tl_tg_id=None,
        log_id=log.id,
        operator_name="Тест Оператор",
        hours=10,
    )


@pytest.mark.django_db
@patch(
    "apps.attendance.management.commands.attendance_long_shift_check.send_long_shift_warning_dms",
    new_callable=AsyncMock,
)
def test_long_shift_warning_no_recipients_skipped(mock_send, operator, user_op, user_tl):
    user_op.profile.telegram_user_id = None
    user_op.profile.save()
    user_tl.profile.delete()

    checked_in = timezone.now() - dt.timedelta(hours=11)
    log = AttendanceLog.objects.create(operator=operator, checked_in_at=checked_in)

    call_command("attendance_long_shift_check")
    mock_send.assert_not_called()

    log.refresh_from_db()
    assert log.long_shift_warning_sent_at is None
    assert AuditLog.objects.filter(action="attendance.warning_skipped_no_recipients").exists()


@pytest.mark.django_db
@override_settings(ATTENDANCE_SCAN_COOLDOWN_SECONDS=0)
def test_operator_confirms_auto_checkout_via_callback(operator, user_op):
    checked_in = timezone.now() - dt.timedelta(minutes=5)
    log = AttendanceLog.objects.create(operator=operator, checked_in_at=checked_in, source="tg")

    res = _bot_auto_checkout_confirm(11111, log.id)
    assert res["ok"] is True
    assert "Смена:" in res["text"]

    log.refresh_from_db()
    assert log.checked_out_at is not None
    assert log.source == "tg"


@pytest.mark.django_db
def test_operator_dismisses_warning_no_repeat(operator, user_op):
    log = AttendanceLog.objects.create(operator=operator, checked_in_at=timezone.now())

    res = _bot_continue_working(11111, log.id)
    assert res["ok"] is True

    log.refresh_from_db()
    assert log.warning_dismissed_at is not None


@pytest.mark.django_db
def test_manual_close_endpoint_closes_log(api_client, user_tl, operator):
    log = AttendanceLog.objects.create(operator=operator, checked_in_at=timezone.now())

    api_client.force_authenticate(user_tl)
    r = api_client.post(
        f"/api/attendance/logs/{log.id}/close/",
        data={"note": "TL closed this manually"},
        format="json",
    )
    assert r.status_code == 200
    assert r.json()["manually_closed"] is True
    assert r.json()["manual_close_note"] == "TL closed this manually"

    log.refresh_from_db()
    assert log.checked_out_at is not None
    assert log.manually_closed is True
    assert log.manually_closed_by == user_tl
    assert AuditLog.objects.filter(action="attendance.log_closed_manually").exists()


@pytest.mark.django_db
def test_manual_close_by_operator_forbidden(api_client, user_op, operator):
    log = AttendanceLog.objects.create(operator=operator, checked_in_at=timezone.now())

    api_client.force_authenticate(user_op)
    r = api_client.post(
        f"/api/attendance/logs/{log.id}/close/",
        data={"note": "Forbidden close"},
        format="json",
    )
    assert r.status_code == 403


@pytest.mark.django_db
def test_manual_close_already_closed_returns_409(api_client, user_tl, operator):
    log = AttendanceLog.objects.create(
        operator=operator,
        checked_in_at=timezone.now(),
        checked_out_at=timezone.now(),
    )

    api_client.force_authenticate(user_tl)
    r = api_client.post(
        f"/api/attendance/logs/{log.id}/close/",
        data={"note": "Duplicate"},
        format="json",
    )
    assert r.status_code == 409


@pytest.mark.django_db
def test_report_endpoint_returns_period_stats(api_client, user_tl, operator):
    tz = timezone.get_current_timezone()
    dt1 = dt.datetime(2026, 7, 22, 10, 0, tzinfo=tz)
    dt2 = dt.datetime(2026, 7, 22, 18, 0, tzinfo=tz)

    log = AttendanceLog.objects.create(
        operator=operator,
        checked_in_at=dt1,
        checked_out_at=dt2,
    )

    api_client.force_authenticate(user_tl)
    r = api_client.get(
        "/api/attendance/report/",
        data={"date_from": "2026-07-22", "date_to": "2026-07-22"},
    )
    assert r.status_code == 200
    rows = r.json()["rows"]
    assert len(rows) == 1
    assert rows[0]["operator_name"] == "Тест Оператор"
    assert rows[0]["days_present"] == 1
    assert rows[0]["total_worked_hours"] == 8.0


@pytest.mark.django_db
def test_report_endpoint_permission(api_client, user_op, user_tl):
    # Operator forbidden
    api_client.force_authenticate(user_op)
    r = api_client.get(
        "/api/attendance/report/",
        data={"date_from": "2026-07-22", "date_to": "2026-07-22"},
    )
    assert r.status_code == 403

    # Team lead allowed
    api_client.force_authenticate(user_tl)
    r2 = api_client.get(
        "/api/attendance/report/",
        data={"date_from": "2026-07-22", "date_to": "2026-07-22"},
    )
    assert r2.status_code == 200

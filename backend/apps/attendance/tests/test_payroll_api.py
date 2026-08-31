"""
Тесты API endpoint'ов attendance-based payroll:
  - GET /api/attendance/payroll/           (manager list)
  - GET /api/attendance/payroll/<id>/      (manager detail + xlsx/pdf)
  - GET /api/attendance/my-payroll/        (operator свой)
"""

from __future__ import annotations

import datetime as dt
from decimal import Decimal

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from apps.attendance.models import AttendanceLog
from apps.attendance.selectors import attendance_settings_get
from apps.operators.models import Operator
from apps.users.models import Profile, Role

User = get_user_model()


@pytest.fixture
def api_client():
    return APIClient()


@pytest.fixture
def settings_obj(db):
    s = attendance_settings_get()
    s.shift_start = dt.time(10, 0)
    s.shift_end = dt.time(20, 0)
    s.default_salary_uzs = Decimal("1500000")
    s.default_grace_period_min = 20
    s.default_late_penalty_uzs = Decimal("50000")
    s.default_weekly_day_off = 6
    s.default_attendance_gate_pct = 85
    s.default_weekly_free_absences = 1
    s.save()
    return s


@pytest.fixture
def op(db):
    return Operator.objects.create(full_name="Test Оператор", status="active")


@pytest.fixture
def op_user(db, op):
    u = User.objects.create_user(username="testop", password="x")
    Profile.objects.create(user=u, role=Role.OPERATOR, operator=op)
    return u


@pytest.fixture
def manager(db):
    u = User.objects.create_user(username="mgr", password="x")
    Profile.objects.create(user=u, role=Role.MANAGER)
    return u


def _fill_month(op: Operator, year: int, month: int):
    import calendar

    tz = timezone.get_current_timezone()
    _, last = calendar.monthrange(year, month)
    for d in range(1, last + 1):
        day = dt.date(year, month, d)
        if day.weekday() == 6:  # Вс — выходной
            continue
        ts = dt.datetime(year, month, d, 10, 0, tzinfo=tz)
        AttendanceLog.objects.create(
            operator=op,
            checked_in_at=ts,
            checked_out_at=ts + dt.timedelta(hours=8),
            was_late=False,
            source="manual",
        )


@pytest.mark.django_db
def test_manager_can_list_payroll(api_client, manager, op, settings_obj):
    api_client.force_authenticate(manager)
    r = api_client.get("/api/attendance/payroll/?month=2026-03")
    assert r.status_code == 200, r.content
    body = r.json()
    assert body["period"] == {"year": 2026, "month": 3}
    assert any(row["operator_id"] == op.id for row in body["rows"])


@pytest.mark.django_db
def test_operator_cannot_access_manager_payroll(api_client, op_user, op, settings_obj):
    """Оператор получает 403 на менеджерский /payroll/."""
    api_client.force_authenticate(op_user)
    r = api_client.get("/api/attendance/payroll/?month=2026-03")
    assert r.status_code == 403


@pytest.mark.django_db
def test_operator_can_access_own_payroll(api_client, op_user, op, settings_obj):
    _fill_month(op, 2026, 3)
    api_client.force_authenticate(op_user)
    r = api_client.get("/api/attendance/my-payroll/?month=2026-03")
    assert r.status_code == 200
    body = r.json()
    assert body["operator_id"] == op.id
    assert body["year"] == 2026 and body["month"] == 3
    assert "days" in body
    assert body["salary_earned"] == "1500000"


@pytest.mark.django_db
def test_my_payroll_xlsx_download(api_client, op_user, op, settings_obj):
    _fill_month(op, 2026, 3)
    api_client.force_authenticate(op_user)
    r = api_client.get("/api/attendance/my-payroll/?month=2026-03&export=xlsx")
    assert r.status_code == 200
    assert r["Content-Type"] == (
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    )
    assert "attachment" in r["Content-Disposition"]
    assert len(r.content) > 500  # некоторый Excel-байт-сalad


@pytest.mark.django_db
def test_my_payroll_pdf_download(api_client, op_user, op, settings_obj):
    _fill_month(op, 2026, 3)
    api_client.force_authenticate(op_user)
    r = api_client.get("/api/attendance/my-payroll/?month=2026-03&export=pdf")
    assert r.status_code == 200
    assert r["Content-Type"] == "application/pdf"
    assert r.content[:4] == b"%PDF"


@pytest.mark.django_db
def test_manager_can_download_operator_xlsx(api_client, manager, op, settings_obj):
    _fill_month(op, 2026, 3)
    api_client.force_authenticate(manager)
    r = api_client.get(
        f"/api/attendance/payroll/{op.id}/?month=2026-03&export=xlsx"
    )
    assert r.status_code == 200
    assert "spreadsheetml" in r["Content-Type"]


@pytest.mark.django_db
def test_manager_detail_returns_days_breakdown(api_client, manager, op, settings_obj):
    _fill_month(op, 2026, 3)
    api_client.force_authenticate(manager)
    r = api_client.get(f"/api/attendance/payroll/{op.id}/?month=2026-03")
    assert r.status_code == 200
    body = r.json()
    # 31 день в марте.
    assert len(body["days"]) == 31


@pytest.mark.django_db
def test_default_month_falls_back_to_current(api_client, manager, op, settings_obj):
    """Без ?month — используется текущий месяц Ташкента."""
    api_client.force_authenticate(manager)
    r = api_client.get("/api/attendance/payroll/")
    assert r.status_code == 200
    today = timezone.localdate()
    assert r.json()["period"] == {"year": today.year, "month": today.month}

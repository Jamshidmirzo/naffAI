import pytest
import datetime as dt
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient
from django.test import override_settings

from apps.operators.models import Operator
from apps.users.models import Profile, Role
from apps.attendance.models import OperatorQr, AttendanceLog, AttendanceSettings
from apps.attendance.services import qr_token_build

User = get_user_model()


@pytest.fixture
def api_client():
    return APIClient()


@pytest.fixture
def op1(db):
    return Operator.objects.create(full_name="Оп Один", status="active")


@pytest.fixture
def op2(db):
    return Operator.objects.create(full_name="Оп Два", status="active")


@pytest.fixture
def user1(db, op1):
    user = User.objects.create_user(username="op1", password="x")
    Profile.objects.create(user=user, role=Role.OPERATOR, operator=op1)
    return user


@pytest.fixture
def user2(db, op2):
    user = User.objects.create_user(username="op2", password="x")
    Profile.objects.create(user=user, role=Role.OPERATOR, operator=op2)
    return user


@pytest.fixture
def team_lead(db):
    user = User.objects.create_user(username="tl", password="x")
    Profile.objects.create(user=user, role=Role.TEAM_LEAD)
    return user


@pytest.mark.django_db
def test_qr_png_endpoint_access(api_client, user1, user2, op1, op2):
    # Operator 1 requests their own QR image
    api_client.force_authenticate(user1)
    r = api_client.get("/api/me/attendance-qr.png")
    assert r.status_code == 200
    assert r["Content-Type"] == "image/png"

    # Operator 1 cannot read Operator 2's QR png
    r2 = api_client.get(f"/api/attendance/operators/{op2.id}/qr.png")
    assert r2.status_code == 403


@pytest.mark.django_db
def test_rotate_qr_endpoint(api_client, team_lead, op1):
    api_client.force_authenticate(team_lead)

    # Rotate
    r = api_client.post(f"/api/attendance/operators/{op1.id}/qr/rotate/")
    assert r.status_code == 200
    assert "png_url" in r.json()

    # Active count
    assert OperatorQr.objects.filter(operator=op1, revoked_at__isnull=True).count() == 1


@pytest.mark.django_db
def test_api_operator_isolation(api_client, user1, op2):
    api_client.force_authenticate(user1)

    # Querying logs of other operator (op2)
    r = api_client.get(f"/api/attendance/operators/{op2.id}/logs/")
    assert r.status_code == 403


@pytest.mark.django_db
def test_settings_singleton_api(api_client, team_lead):
    api_client.force_authenticate(team_lead)

    r = api_client.patch(
        "/api/attendance/settings/",
        data={"shift_start": "09:00", "tg_checkin_enabled": False},
        format="json",
    )
    assert r.status_code == 200
    assert r.json()["shift_start"] == "09:00"
    assert r.json()["tg_checkin_enabled"] is False

    # Verify database has exactly one settings row
    assert AttendanceSettings.objects.count() == 1


@pytest.mark.django_db
def test_scan_api_throttle(api_client):
    from django.conf import settings

    rates = settings.REST_FRAMEWORK["DEFAULT_THROTTLE_RATES"]
    original_rate = rates.get("attendance_scan_ip")
    rates["attendance_scan_ip"] = "2/min"

    try:
        # Request 1
        r = api_client.post("/api/attendance/scan/", data={"qr_payload": ""})
        assert r.status_code == 400

        # Request 2
        r = api_client.post("/api/attendance/scan/", data={"qr_payload": ""})
        assert r.status_code == 400

        # Request 3 -> Throttle
        r = api_client.post("/api/attendance/scan/", data={"qr_payload": ""})
        assert r.status_code == 429
    finally:
        if original_rate is not None:
            rates["attendance_scan_ip"] = original_rate
        else:
            rates.pop("attendance_scan_ip", None)

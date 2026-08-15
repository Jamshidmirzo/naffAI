"""
Attendance PIN-gate tests.

Покрываем: set / verify / TTL / superadmin bypass / reset (superadmin only) /
401 pin_required на защищённом endpoint'e.
"""

from __future__ import annotations

import datetime as dt

import pytest
from django.contrib.auth import get_user_model
from django.contrib.auth.hashers import check_password
from django.utils import timezone
from rest_framework.test import APIClient

from apps.attendance.models import AttendancePinSession
from apps.attendance.pin_services import PIN_TTL
from apps.operators.models import Operator
from apps.users.models import Profile, Role

User = get_user_model()

# Отмечаем весь модуль — conftest.py в attendance/tests/ пропускает
# автомок PIN-сессии, чтобы фактически проверить сам gate.
pytestmark = pytest.mark.pin_gate


@pytest.fixture
def client():
    return APIClient()


@pytest.fixture
def manager(db):
    u = User.objects.create_user(username="mgr1", password="x")
    Profile.objects.create(user=u, role=Role.MANAGER)
    return u


@pytest.fixture
def manager2(db):
    u = User.objects.create_user(username="mgr2", password="x")
    Profile.objects.create(user=u, role=Role.MANAGER)
    return u


@pytest.fixture
def superadmin(db):
    u = User.objects.create_user(username="sa1", password="x")
    Profile.objects.create(user=u, role=Role.SUPERADMIN)
    return u


@pytest.fixture
def operator_user(db):
    op = Operator.objects.create(full_name="Тест Оп", status="active")
    u = User.objects.create_user(username="op1", password="x")
    Profile.objects.create(user=u, role=Role.OPERATOR, operator=op)
    return u


# --------------------------- SET ---------------------------------------------


@pytest.mark.django_db
def test_pin_set_first_time_saves_hash(client, manager):
    client.force_authenticate(manager)
    r = client.post("/api/attendance/pin/set/", {"new_pin": "1234"}, format="json")
    assert r.status_code == 200, r.content
    manager.profile.refresh_from_db()
    assert manager.profile.attendance_pin_hash
    assert check_password("1234", manager.profile.attendance_pin_hash)


@pytest.mark.django_db
def test_pin_set_rejects_non_digits(client, manager):
    client.force_authenticate(manager)
    r = client.post("/api/attendance/pin/set/", {"new_pin": "abcd"}, format="json")
    assert r.status_code == 400


@pytest.mark.django_db
def test_pin_set_rejects_wrong_length(client, manager):
    client.force_authenticate(manager)
    for bad in ("123", "12345", ""):
        r = client.post("/api/attendance/pin/set/", {"new_pin": bad}, format="json")
        assert r.status_code == 400


@pytest.mark.django_db
def test_pin_set_requires_old_pin_if_already_set(client, manager):
    client.force_authenticate(manager)
    # First-time set OK
    assert client.post("/api/attendance/pin/set/", {"new_pin": "1111"}, format="json").status_code == 200
    # Change without old_pin — fail
    r = client.post("/api/attendance/pin/set/", {"new_pin": "2222"}, format="json")
    assert r.status_code == 400
    # Change with wrong old_pin — fail
    r = client.post(
        "/api/attendance/pin/set/", {"new_pin": "2222", "old_pin": "9999"}, format="json"
    )
    assert r.status_code == 400
    # Change with correct old_pin — OK
    r = client.post(
        "/api/attendance/pin/set/", {"new_pin": "2222", "old_pin": "1111"}, format="json"
    )
    assert r.status_code == 200
    manager.profile.refresh_from_db()
    assert check_password("2222", manager.profile.attendance_pin_hash)


@pytest.mark.django_db
def test_pin_set_invalidates_existing_session(client, manager):
    client.force_authenticate(manager)
    client.post("/api/attendance/pin/set/", {"new_pin": "1234"}, format="json")
    client.post("/api/attendance/pin/verify/", {"pin": "1234"}, format="json")
    assert AttendancePinSession.objects.filter(user=manager).exists()
    # Re-set (with correct old pin) должен убить сессию
    client.post(
        "/api/attendance/pin/set/", {"new_pin": "5678", "old_pin": "1234"}, format="json"
    )
    assert not AttendancePinSession.objects.filter(user=manager).exists()


# --------------------------- VERIFY ------------------------------------------


@pytest.mark.django_db
def test_pin_verify_success_creates_session(client, manager):
    client.force_authenticate(manager)
    client.post("/api/attendance/pin/set/", {"new_pin": "4321"}, format="json")
    r = client.post("/api/attendance/pin/verify/", {"pin": "4321"}, format="json")
    assert r.status_code == 200, r.content
    body = r.json()
    assert body["ok"] is True
    assert body["expires_at"]
    assert AttendancePinSession.objects.filter(user=manager).exists()


@pytest.mark.django_db
def test_pin_verify_wrong_pin_400(client, manager):
    client.force_authenticate(manager)
    client.post("/api/attendance/pin/set/", {"new_pin": "1234"}, format="json")
    r = client.post("/api/attendance/pin/verify/", {"pin": "0000"}, format="json")
    assert r.status_code == 400


@pytest.mark.django_db
def test_pin_verify_before_set_400(client, manager):
    client.force_authenticate(manager)
    r = client.post("/api/attendance/pin/verify/", {"pin": "1234"}, format="json")
    assert r.status_code == 400


# --------------------------- STATUS ------------------------------------------


@pytest.mark.django_db
def test_pin_status_reflects_state(client, manager):
    client.force_authenticate(manager)
    # No PIN yet
    body = client.get("/api/attendance/pin/status/").json()
    assert body["has_pin"] is False
    assert body["pin_required"] is True
    assert body["pin_verified"] is False

    client.post("/api/attendance/pin/set/", {"new_pin": "1234"}, format="json")
    body = client.get("/api/attendance/pin/status/").json()
    assert body["has_pin"] is True
    assert body["pin_verified"] is False

    client.post("/api/attendance/pin/verify/", {"pin": "1234"}, format="json")
    body = client.get("/api/attendance/pin/status/").json()
    assert body["pin_verified"] is True
    assert body["expires_at"]


@pytest.mark.django_db
def test_pin_status_superadmin_never_requires(client, superadmin):
    client.force_authenticate(superadmin)
    body = client.get("/api/attendance/pin/status/").json()
    assert body["pin_required"] is False
    assert body["pin_verified"] is True


# --------------------------- TTL ---------------------------------------------


@pytest.mark.django_db
def test_pin_session_expires_after_ttl(client, manager):
    client.force_authenticate(manager)
    client.post("/api/attendance/pin/set/", {"new_pin": "1234"}, format="json")
    client.post("/api/attendance/pin/verify/", {"pin": "1234"}, format="json")

    # Rewind session in DB > TTL ago
    sess = AttendancePinSession.objects.get(user=manager)
    sess.verified_at = timezone.now() - PIN_TTL - dt.timedelta(minutes=1)
    sess.save(update_fields=["verified_at"])

    # Access to protected endpoint должен вернуть 401 pin_required
    r = client.get("/api/attendance/photos/")
    assert r.status_code == 401
    body = r.json()
    assert body.get("code") == "pin_required"


# --------------------------- SUPERADMIN BYPASS -------------------------------


@pytest.mark.django_db
def test_superadmin_bypasses_pin_on_photos(client, superadmin):
    client.force_authenticate(superadmin)
    r = client.get("/api/attendance/photos/")
    # Гарантируем что PIN-gate НЕ отдал 401
    assert r.status_code != 401
    assert r.status_code == 200


@pytest.mark.django_db
def test_superadmin_bypasses_pin_on_report(client, superadmin):
    client.force_authenticate(superadmin)
    r = client.get("/api/attendance/report/")
    assert r.status_code == 200


# --------------------------- MANAGER 401 pin_required -----------------------


@pytest.mark.django_db
def test_manager_no_pin_gets_pin_required_on_photos(client, manager):
    client.force_authenticate(manager)
    r = client.get("/api/attendance/photos/")
    assert r.status_code == 401
    assert r.json().get("code") == "pin_required"


@pytest.mark.django_db
def test_manager_with_verified_pin_passes(client, manager):
    client.force_authenticate(manager)
    client.post("/api/attendance/pin/set/", {"new_pin": "1234"}, format="json")
    client.post("/api/attendance/pin/verify/", {"pin": "1234"}, format="json")
    r = client.get("/api/attendance/photos/")
    assert r.status_code == 200


@pytest.mark.django_db
def test_operator_still_gets_403_not_pin_required(client, operator_user):
    """Оператор не должен видеть 401 pin_required — ему возвращаем 403
    от IsTeamLeadOrManager / IsSuperadminOrManager (не наше поле)."""
    client.force_authenticate(operator_user)
    r = client.get("/api/attendance/photos/")
    assert r.status_code == 403


# --------------------------- RESET -------------------------------------------


@pytest.mark.django_db
def test_pin_reset_by_superadmin_clears_hash_and_session(client, superadmin, manager):
    # Manager sets + verifies PIN
    c2 = APIClient()
    c2.force_authenticate(manager)
    c2.post("/api/attendance/pin/set/", {"new_pin": "1234"}, format="json")
    c2.post("/api/attendance/pin/verify/", {"pin": "1234"}, format="json")
    assert AttendancePinSession.objects.filter(user=manager).exists()

    # Superadmin resets
    client.force_authenticate(superadmin)
    r = client.post(f"/api/attendance/pin/reset/{manager.profile.pk}/")
    assert r.status_code == 200, r.content

    manager.profile.refresh_from_db()
    assert manager.profile.attendance_pin_hash == ""
    assert not AttendancePinSession.objects.filter(user=manager).exists()


@pytest.mark.django_db
def test_pin_reset_accepts_user_id_fallback(client, superadmin, manager):
    """Фронт передаёт либо profile_id, либо user_id — endpoint должен принять оба."""
    c2 = APIClient()
    c2.force_authenticate(manager)
    c2.post("/api/attendance/pin/set/", {"new_pin": "1234"}, format="json")

    client.force_authenticate(superadmin)
    r = client.post(f"/api/attendance/pin/reset/{manager.id}/")
    assert r.status_code == 200
    manager.profile.refresh_from_db()
    assert manager.profile.attendance_pin_hash == ""


@pytest.mark.django_db
def test_pin_reset_forbidden_for_manager(client, manager, manager2):
    """Обычный менеджер не может сбросить PIN другому менеджеру."""
    # manager2 задаёт PIN
    c2 = APIClient()
    c2.force_authenticate(manager2)
    c2.post("/api/attendance/pin/set/", {"new_pin": "1234"}, format="json")

    # manager пытается сбросить PIN у manager2
    client.force_authenticate(manager)
    r = client.post(f"/api/attendance/pin/reset/{manager2.profile.pk}/")
    assert r.status_code == 403

    manager2.profile.refresh_from_db()
    assert manager2.profile.attendance_pin_hash  # не тронуто


@pytest.mark.django_db
def test_pin_reset_forbidden_on_operator_target(client, superadmin, operator_user):
    """Superadmin не может «сбросить PIN» оператору — у оператора PIN'a нет,
    endpoint отдаёт 403 (guard-семантика)."""
    client.force_authenticate(superadmin)
    r = client.post(f"/api/attendance/pin/reset/{operator_user.profile.pk}/")
    assert r.status_code == 403

"""
Attendance PIN-gate tests (2026-08-15 global-PIN redesign).

Покрываем:
- set/reset разрешены только superadmin'у;
- verify против глобального PIN'a работает для всех менеджеров;
- изменение PIN'a инвалидирует все personal-сессии;
- reset инвалидирует все personal-сессии;
- TTL;
- superadmin bypass;
- pin_required 401 для менеджера без сессии.
"""

from __future__ import annotations

import datetime as dt

import pytest
from django.contrib.auth import get_user_model
from django.contrib.auth.hashers import check_password
from django.utils import timezone
from rest_framework.test import APIClient

from apps.attendance.models import AttendancePinSession, AttendanceSettings
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
def superadmin2(db):
    u = User.objects.create_user(username="sa2", password="x")
    Profile.objects.create(user=u, role=Role.SUPERADMIN)
    return u


@pytest.fixture
def operator_user(db):
    op = Operator.objects.create(full_name="Тест Оп", status="active")
    u = User.objects.create_user(username="op1", password="x")
    Profile.objects.create(user=u, role=Role.OPERATOR, operator=op)
    return u


def _sa_set(client: APIClient, sa: User, pin: str) -> None:
    """Хелпер: superadmin задаёт глобальный PIN."""
    client.force_authenticate(sa)
    r = client.post("/api/attendance/pin/set/", {"new_pin": pin}, format="json")
    assert r.status_code == 200, r.content


# --------------------------- SET ---------------------------------------------


@pytest.mark.django_db
def test_pin_set_by_superadmin_saves_global_hash(client, superadmin):
    client.force_authenticate(superadmin)
    r = client.post("/api/attendance/pin/set/", {"new_pin": "1234"}, format="json")
    assert r.status_code == 200, r.content

    settings_obj = AttendanceSettings.objects.get(pk=1)
    assert settings_obj.pin_hash
    assert check_password("1234", settings_obj.pin_hash)
    assert settings_obj.pin_updated_by_id == superadmin.id
    assert settings_obj.pin_updated_at is not None


@pytest.mark.django_db
def test_pin_set_by_manager_forbidden(client, manager):
    client.force_authenticate(manager)
    r = client.post("/api/attendance/pin/set/", {"new_pin": "1234"}, format="json")
    assert r.status_code == 403
    # Ничего не записалось
    assert not AttendanceSettings.objects.filter(pk=1, pin_hash__isnull=False).exclude(pin_hash="").exists()


@pytest.mark.django_db
def test_pin_set_by_operator_forbidden(client, operator_user):
    client.force_authenticate(operator_user)
    r = client.post("/api/attendance/pin/set/", {"new_pin": "1234"}, format="json")
    assert r.status_code == 403


@pytest.mark.django_db
def test_pin_set_rejects_non_digits(client, superadmin):
    client.force_authenticate(superadmin)
    r = client.post("/api/attendance/pin/set/", {"new_pin": "abcd"}, format="json")
    assert r.status_code == 400


@pytest.mark.django_db
def test_pin_set_rejects_wrong_length(client, superadmin):
    client.force_authenticate(superadmin)
    for bad in ("123", "12345", ""):
        r = client.post("/api/attendance/pin/set/", {"new_pin": bad}, format="json")
        assert r.status_code == 400


@pytest.mark.django_db
def test_pin_change_invalidates_all_sessions(client, superadmin, manager, manager2):
    """Смена PIN'a чистит ВСЕ personal-сессии, чтобы менеджеры заново ввели новый."""
    _sa_set(client, superadmin, "1111")

    # Оба менеджера verify-ятся под старым PIN'ом
    for m in (manager, manager2):
        c = APIClient()
        c.force_authenticate(m)
        assert c.post("/api/attendance/pin/verify/", {"pin": "1111"}, format="json").status_code == 200
    assert AttendancePinSession.objects.count() == 2

    # Superadmin меняет PIN
    _sa_set(client, superadmin, "2222")
    assert AttendancePinSession.objects.count() == 0

    # Старый PIN больше не подходит
    c = APIClient()
    c.force_authenticate(manager)
    r = c.post("/api/attendance/pin/verify/", {"pin": "1111"}, format="json")
    assert r.status_code == 400


# --------------------------- VERIFY ------------------------------------------


@pytest.mark.django_db
def test_pin_verify_success_creates_session(client, superadmin, manager):
    _sa_set(client, superadmin, "4321")

    c = APIClient()
    c.force_authenticate(manager)
    r = c.post("/api/attendance/pin/verify/", {"pin": "4321"}, format="json")
    assert r.status_code == 200, r.content
    body = r.json()
    assert body["ok"] is True
    assert body["expires_at"]
    assert AttendancePinSession.objects.filter(user=manager).exists()


@pytest.mark.django_db
def test_pin_verify_wrong_pin_400(client, superadmin, manager):
    _sa_set(client, superadmin, "1234")

    c = APIClient()
    c.force_authenticate(manager)
    r = c.post("/api/attendance/pin/verify/", {"pin": "0000"}, format="json")
    assert r.status_code == 400


@pytest.mark.django_db
def test_pin_verify_before_set_400(client, manager):
    """PIN ещё не задан суперадмином — verify отвергает."""
    client.force_authenticate(manager)
    r = client.post("/api/attendance/pin/verify/", {"pin": "1234"}, format="json")
    assert r.status_code == 400


@pytest.mark.django_db
def test_global_pin_shared_across_managers(client, superadmin, manager, manager2):
    """Тот же PIN проходит у разных менеджеров — по определению «глобальный»."""
    _sa_set(client, superadmin, "9876")

    for m in (manager, manager2):
        c = APIClient()
        c.force_authenticate(m)
        r = c.post("/api/attendance/pin/verify/", {"pin": "9876"}, format="json")
        assert r.status_code == 200


# --------------------------- STATUS ------------------------------------------


@pytest.mark.django_db
def test_pin_status_reflects_state(client, superadmin, manager):
    # No PIN yet — менеджер видит has_pin=False
    client.force_authenticate(manager)
    body = client.get("/api/attendance/pin/status/").json()
    assert body["has_pin"] is False
    assert body["pin_required"] is True
    assert body["pin_verified"] is False

    _sa_set(client, superadmin, "1234")

    # После set — has_pin=True, но verified=False (менеджер ещё не вводил)
    client.force_authenticate(manager)
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


@pytest.mark.django_db
def test_pin_status_includes_updated_meta(client, superadmin, manager):
    _sa_set(client, superadmin, "1234")
    client.force_authenticate(manager)
    body = client.get("/api/attendance/pin/status/").json()
    assert body["updated_at"]  # non-null
    assert body["updated_by"] == "sa1"


# --------------------------- TTL ---------------------------------------------


@pytest.mark.django_db
def test_pin_session_expires_after_ttl(client, superadmin, manager):
    _sa_set(client, superadmin, "1234")

    c = APIClient()
    c.force_authenticate(manager)
    c.post("/api/attendance/pin/verify/", {"pin": "1234"}, format="json")

    # Rewind session in DB > TTL ago
    sess = AttendancePinSession.objects.get(user=manager)
    sess.verified_at = timezone.now() - PIN_TTL - dt.timedelta(minutes=1)
    sess.save(update_fields=["verified_at"])

    r = c.get("/api/attendance/photos/")
    assert r.status_code == 401
    assert r.json().get("code") == "pin_required"


# --------------------------- SUPERADMIN BYPASS -------------------------------


@pytest.mark.django_db
def test_superadmin_bypasses_pin_on_photos(client, superadmin):
    client.force_authenticate(superadmin)
    r = client.get("/api/attendance/photos/")
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
def test_manager_with_verified_pin_passes(client, superadmin, manager):
    _sa_set(client, superadmin, "1234")

    c = APIClient()
    c.force_authenticate(manager)
    c.post("/api/attendance/pin/verify/", {"pin": "1234"}, format="json")
    r = c.get("/api/attendance/photos/")
    assert r.status_code == 200


@pytest.mark.django_db
def test_operator_still_gets_403_not_pin_required(client, operator_user):
    """Оператор не должен видеть 401 pin_required — ему возвращаем 403
    от IsTeamLeadOrManager / IsSuperadminOrManager."""
    client.force_authenticate(operator_user)
    r = client.get("/api/attendance/photos/")
    assert r.status_code == 403


# --------------------------- RESET -------------------------------------------


@pytest.mark.django_db
def test_pin_reset_by_superadmin_clears_hash_and_all_sessions(
    client, superadmin, manager, manager2
):
    _sa_set(client, superadmin, "1234")

    # Оба менеджера verified
    for m in (manager, manager2):
        c = APIClient()
        c.force_authenticate(m)
        c.post("/api/attendance/pin/verify/", {"pin": "1234"}, format="json")
    assert AttendancePinSession.objects.count() == 2

    # Superadmin reset без body
    client.force_authenticate(superadmin)
    r = client.post("/api/attendance/pin/reset/")
    assert r.status_code == 200, r.content

    settings_obj = AttendanceSettings.objects.get(pk=1)
    assert settings_obj.pin_hash == ""
    assert AttendancePinSession.objects.count() == 0


@pytest.mark.django_db
def test_pin_reset_forbidden_for_manager(client, superadmin, manager):
    _sa_set(client, superadmin, "1234")

    client.force_authenticate(manager)
    r = client.post("/api/attendance/pin/reset/")
    assert r.status_code == 403

    settings_obj = AttendanceSettings.objects.get(pk=1)
    assert settings_obj.pin_hash  # не тронуто


@pytest.mark.django_db
def test_pin_reset_forbidden_for_operator(client, operator_user):
    client.force_authenticate(operator_user)
    r = client.post("/api/attendance/pin/reset/")
    assert r.status_code == 403


@pytest.mark.django_db
def test_after_reset_managers_locked_out_until_new_set(
    client, superadmin, superadmin2, manager
):
    _sa_set(client, superadmin, "1234")

    c = APIClient()
    c.force_authenticate(manager)
    c.post("/api/attendance/pin/verify/", {"pin": "1234"}, format="json")

    # Superadmin reset
    client.force_authenticate(superadmin2)
    client.post("/api/attendance/pin/reset/")

    # Manager сразу выкинут с 401 pin_required
    r = c.get("/api/attendance/photos/")
    assert r.status_code == 401
    assert r.json().get("code") == "pin_required"

    # Старый PIN больше не работает
    r = c.post("/api/attendance/pin/verify/", {"pin": "1234"}, format="json")
    assert r.status_code == 400

    # Пока новый не задан — /verify/ вообще отвергает всё
    r = c.post("/api/attendance/pin/verify/", {"pin": "0000"}, format="json")
    assert r.status_code == 400

    # Superadmin задаёт новый
    _sa_set(client, superadmin, "5678")

    # Теперь менеджер входит по новому
    r = c.post("/api/attendance/pin/verify/", {"pin": "5678"}, format="json")
    assert r.status_code == 200

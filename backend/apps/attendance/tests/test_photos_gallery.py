"""
Тесты галереи фото attendance — endpoint `GET /api/attendance/photos/`.

Проверяем:
  1. superadmin получает 200 и видит логи с фото;
  2. manager тоже получает 200 (галерея открыта всем senior);
  3. operator получает 403 (даже свой собственный фото — не через этот
     endpoint);
  4. фильтры date_from / date_to / operator работают;
  5. логи без фото не попадают в выдачу.
"""

from __future__ import annotations

import datetime as dt
import io

import pytest
from django.contrib.auth import get_user_model
from django.core.files.uploadedfile import SimpleUploadedFile
from django.utils import timezone
from PIL import Image
from rest_framework.test import APIClient

from apps.attendance.models import AttendanceLog
from apps.operators.models import Operator
from apps.users.models import Profile, Role


User = get_user_model()


def _jpeg_bytes(color: tuple[int, int, int] = (200, 120, 80)) -> bytes:
    img = Image.new("RGB", (32, 32), color)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=80)
    return buf.getvalue()


def _make_photo(name: str = "x.jpg") -> SimpleUploadedFile:
    return SimpleUploadedFile(name, _jpeg_bytes(), content_type="image/jpeg")


@pytest.fixture
def api_client():
    return APIClient()


@pytest.fixture
def operator_a(db):
    return Operator.objects.create(full_name="Alice A", status="active")


@pytest.fixture
def operator_b(db):
    return Operator.objects.create(full_name="Bob B", status="active")


@pytest.fixture
def superadmin(db):
    u = User.objects.create_user(username="opercoder_test", password="x")
    Profile.objects.create(user=u, role=Role.SUPERADMIN)
    return u


@pytest.fixture
def manager(db):
    u = User.objects.create_user(username="mgr_photo", password="x")
    Profile.objects.create(user=u, role=Role.MANAGER)
    return u


@pytest.fixture
def operator_user(db, operator_a):
    u = User.objects.create_user(username="op_photo", password="x")
    Profile.objects.create(user=u, role=Role.OPERATOR, operator=operator_a)
    return u


def _log(op, when: dt.datetime, *, with_photo: bool = True, closed: bool = True):
    # DB enforces «одна открытая смена на оператора» — тесты, которым
    # нужно несколько логов подряд для одного оператора, закрывают
    # смену через 8 часов (типовая шестичасовая-восьмичасовая).
    log = AttendanceLog.objects.create(
        operator=op,
        checked_in_at=when,
        checked_out_at=when + dt.timedelta(hours=8) if closed else None,
        source="qr",
    )
    if with_photo:
        log.checkin_photo = _make_photo(f"in-{log.id}.jpg")
        log.save(update_fields=["checkin_photo"])
    return log


@pytest.mark.django_db
def test_superadmin_can_list_photos(api_client, superadmin, operator_a):
    _log(operator_a, timezone.now())
    api_client.force_authenticate(superadmin)
    r = api_client.get("/api/attendance/photos/")
    assert r.status_code == 200, r.content
    body = r.json()
    assert body["count"] == 1
    row = body["results"][0]
    assert row["operator_id"] == operator_a.id
    assert row["operator_name"] == "Alice A"
    assert row["checkin_photo_url"]  # media URL populated


@pytest.mark.django_db
def test_manager_can_list_photos(api_client, manager, operator_a):
    _log(operator_a, timezone.now())
    api_client.force_authenticate(manager)
    r = api_client.get("/api/attendance/photos/")
    assert r.status_code == 200
    assert r.json()["count"] == 1


@pytest.mark.django_db
def test_operator_forbidden(api_client, operator_user, operator_a):
    _log(operator_a, timezone.now())
    api_client.force_authenticate(operator_user)
    r = api_client.get("/api/attendance/photos/")
    assert r.status_code == 403


@pytest.mark.django_db
def test_filter_by_operator(api_client, superadmin, operator_a, operator_b):
    _log(operator_a, timezone.now())
    _log(operator_b, timezone.now())
    api_client.force_authenticate(superadmin)
    r = api_client.get(f"/api/attendance/photos/?operator={operator_a.id}")
    assert r.status_code == 200
    rows = r.json()["results"]
    assert len(rows) == 1
    assert rows[0]["operator_id"] == operator_a.id


@pytest.mark.django_db
def test_filter_by_date_range(api_client, superadmin, operator_a):
    tz = timezone.get_current_timezone()
    yesterday = timezone.now() - dt.timedelta(days=1)
    today = timezone.now()
    _log(operator_a, yesterday)
    _log(operator_a, today)

    today_str = today.astimezone(tz).date().strftime("%Y-%m-%d")
    api_client.force_authenticate(superadmin)
    r = api_client.get(f"/api/attendance/photos/?date_from={today_str}&date_to={today_str}")
    assert r.status_code == 200
    rows = r.json()["results"]
    # Только сегодняшний лог
    assert len(rows) == 1


@pytest.mark.django_db
def test_logs_without_photo_are_excluded(api_client, superadmin, operator_a):
    _log(operator_a, timezone.now(), with_photo=False)
    api_client.force_authenticate(superadmin)
    r = api_client.get("/api/attendance/photos/")
    assert r.status_code == 200
    assert r.json()["count"] == 0

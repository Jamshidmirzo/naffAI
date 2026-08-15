"""
Integration tests for the attendance photo endpoints.

Covers:
- `POST /attendance/me/scan-with-photo/` — happy path (check-in with
   photo → phash saved on log, photo_url returned).
- Duplicate detection: same phash within 24h rejected.
- Missing photo when the endpoint requires it.
- Settings endpoint exposes/persists new toggles.
"""

from __future__ import annotations

import io
from pathlib import Path

import pytest
from django.contrib.auth import get_user_model
from PIL import Image
from rest_framework.test import APIClient

from apps.attendance.models import AttendanceLog, AttendanceSettings
from apps.attendance.services import operator_qr_rotate, qr_token_build
from apps.operators.models import Operator
from apps.users.models import Profile, Role


User = get_user_model()
FIXTURES_DIR = Path(__file__).parent / "fixtures"


def _tiny_jpeg_bytes(color: tuple[int, int, int] = (255, 200, 100)) -> bytes:
    """Generate a fresh JPEG in-memory (different byte content per call)."""
    img = Image.new("RGB", (64, 64), color)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=85)
    return buf.getvalue()


@pytest.fixture
def api_client():
    return APIClient()


@pytest.fixture
def operator(db):
    return Operator.objects.create(full_name="Оп Фото", status="active")


@pytest.fixture
def user_profile(db, operator):
    u = User.objects.create_user(username="phop", password="x")
    Profile.objects.create(user=u, role=Role.OPERATOR, operator=operator)
    return u


@pytest.fixture
def qr_payload(operator, user_profile):
    qr = operator_qr_rotate(operator=operator, actor=user_profile)
    return qr_token_build(operator, qr.nonce)


@pytest.fixture
def team_lead(db):
    u = User.objects.create_user(username="tl_photo", password="x")
    Profile.objects.create(user=u, role=Role.TEAM_LEAD)
    return u


@pytest.mark.django_db
def test_settings_endpoint_exposes_new_photo_fields(api_client, team_lead):
    api_client.force_authenticate(team_lead)
    r = api_client.get("/api/attendance/settings/")
    assert r.status_code == 200
    body = r.json()
    for key in ("require_photo", "require_face", "photo_max_size_mb"):
        assert key in body, f"missing field {key} in {body}"
    # defaults: require_photo=False, require_face=True, size=5
    assert body["require_photo"] is False
    assert body["require_face"] is True
    assert body["photo_max_size_mb"] == 5


@pytest.mark.django_db
def test_settings_endpoint_persists_toggles(api_client, team_lead):
    api_client.force_authenticate(team_lead)
    r = api_client.patch(
        "/api/attendance/settings/",
        data={"require_photo": True, "photo_max_size_mb": 8},
        format="json",
    )
    assert r.status_code == 200
    body = r.json()
    assert body["require_photo"] is True
    assert body["photo_max_size_mb"] == 8
    obj = AttendanceSettings.objects.get(pk=1)
    assert obj.require_photo is True
    assert obj.photo_max_size_mb == 8


@pytest.mark.django_db
def test_scan_with_photo_requires_photo_field(api_client, qr_payload):
    r = api_client.post(
        "/api/attendance/me/scan-with-photo/",
        data={"qr_payload": qr_payload},
        format="multipart",
    )
    assert r.status_code == 400
    body = r.json()
    assert body.get("code") == "photo_required"


@pytest.mark.django_db
def test_scan_with_photo_happy_path_check_in(api_client, operator, qr_payload):
    # Turn off face-check so synthetic image passes (MediaPipe/Haar may
    # reject the tiny generated JPEG). Duplicate detection is separate.
    s = AttendanceSettings.objects.get_or_create(pk=1)[0]
    s.require_face = False
    s.save()

    img_bytes = _tiny_jpeg_bytes(color=(100, 200, 50))
    from django.core.files.uploadedfile import SimpleUploadedFile

    photo = SimpleUploadedFile("selfie.jpg", img_bytes, content_type="image/jpeg")

    r = api_client.post(
        "/api/attendance/me/scan-with-photo/",
        data={"qr_payload": qr_payload, "photo": photo},
        format="multipart",
    )
    assert r.status_code == 200, r.content
    body = r.json()
    assert body["action"] == "check_in"
    assert body["operator"]["id"] == operator.id
    assert body["photo_url"] and body["photo_url"].startswith("/media/attendance/")

    log = AttendanceLog.objects.get(operator=operator)
    assert log.checkin_photo, "checkin_photo must be set on the log"
    assert len(log.checkin_photo_phash) == 16, "phash stored on log"


@pytest.mark.django_db
def test_scan_with_photo_rejects_duplicate_within_1h(api_client, operator, qr_payload):
    import datetime as dt
    from django.utils import timezone
    from django.core.files.uploadedfile import SimpleUploadedFile

    # Seed a log with the known phash but well OUTSIDE the 30-second
    # idempotency window (~10 min ago) — this must still be flagged as
    # a duplicate under the 1-hour dup window.
    known_phash = "aaaaaaaaaaaaaaaa"
    AttendanceLog.objects.create(
        operator=operator,
        checked_in_at=timezone.now() - dt.timedelta(minutes=10),
        checked_out_at=timezone.now() - dt.timedelta(minutes=9),
        checkin_photo_phash=known_phash,
    )

    s = AttendanceSettings.objects.get_or_create(pk=1)[0]
    s.require_face = False
    s.save()

    from apps.attendance import face as face_mod
    orig = face_mod.perceptual_hash
    face_mod.perceptual_hash = lambda b: known_phash
    try:
        photo = SimpleUploadedFile(
            "selfie.jpg", _tiny_jpeg_bytes(), content_type="image/jpeg"
        )
        r = api_client.post(
            "/api/attendance/me/scan-with-photo/",
            data={"qr_payload": qr_payload, "photo": photo},
            format="multipart",
        )
        assert r.status_code == 400
        assert "уже использ" in r.json()["error"].lower()
    finally:
        face_mod.perceptual_hash = orig


@pytest.mark.django_db
def test_scan_with_photo_double_submit_within_30s_is_idempotent(
    api_client, operator, qr_payload
):
    """Two identical POSTs within 30s must both return 200 with the same
    successful payload — not a 400 "photo already used" on the second.
    This is the double-tap / retry / iOS-Safari-resubmit guard."""
    from django.core.files.uploadedfile import SimpleUploadedFile

    s = AttendanceSettings.objects.get_or_create(pk=1)[0]
    s.require_face = False
    s.save()

    from apps.attendance import face as face_mod
    orig = face_mod.perceptual_hash
    # Force both requests to compute the exact same phash.
    face_mod.perceptual_hash = lambda b: "b00b1e5c0ff33bee"
    try:
        photo1 = SimpleUploadedFile(
            "selfie.jpg", _tiny_jpeg_bytes(), content_type="image/jpeg"
        )
        r1 = api_client.post(
            "/api/attendance/me/scan-with-photo/",
            data={"qr_payload": qr_payload, "photo": photo1},
            format="multipart",
        )
        assert r1.status_code == 200
        assert r1.json()["action"] == "check_in"

        # Second identical submit — should be idempotent replay, not dup.
        photo2 = SimpleUploadedFile(
            "selfie.jpg", _tiny_jpeg_bytes(), content_type="image/jpeg"
        )
        r2 = api_client.post(
            "/api/attendance/me/scan-with-photo/",
            data={"qr_payload": qr_payload, "photo": photo2},
            format="multipart",
        )
        assert r2.status_code == 200, r2.content
        body2 = r2.json()
        assert body2["action"] == "check_in"
        assert body2.get("idempotent_replay") is True
        # Exactly one log created — no second row.
        assert AttendanceLog.objects.filter(operator=operator).count() == 1
    finally:
        face_mod.perceptual_hash = orig


@pytest.mark.django_db
def test_me_qr_token_returns_operator_scoped_payload(
    api_client, operator, user_profile
):
    """The new operator-self QR-token endpoint returns a valid HMAC
    payload tied to the current authenticated operator only."""
    api_client.force_authenticate(user_profile)
    r = api_client.get("/api/attendance/me/qr-token/")
    assert r.status_code == 200, r.content
    body = r.json()
    assert body["operator_id"] == operator.id
    assert body["operator_name"] == operator.full_name
    assert body["payload"].startswith("naffai-att-v1:")
    assert str(operator.id) in body["payload"]


@pytest.mark.django_db
def test_me_qr_token_rejects_user_without_operator(api_client):
    """A logged-in senior (no linked operator) must get 404."""
    lone = User.objects.create_user(username="lone_tl", password="x")
    Profile.objects.create(user=lone, role=Role.TEAM_LEAD, operator=None)
    api_client.force_authenticate(lone)
    r = api_client.get("/api/attendance/me/qr-token/")
    assert r.status_code == 404


@pytest.mark.django_db
def test_scan_legacy_endpoint_ignores_photo_when_require_photo_false(
    api_client, qr_payload, operator
):
    """Back-compat: /attendance/scan/ still works without photo when
    require_photo=False globally."""
    r = api_client.post(
        "/api/attendance/scan/",
        data={"qr_payload": qr_payload},
        format="json",
    )
    assert r.status_code == 200
    body = r.json()
    assert body["action"] == "check_in"
    assert body.get("photo_url") in (None, "")


@pytest.mark.django_db
def test_scan_legacy_endpoint_rejects_when_require_photo_true(api_client, qr_payload):
    s = AttendanceSettings.objects.get_or_create(pk=1)[0]
    s.require_photo = True
    s.save()

    r = api_client.post(
        "/api/attendance/scan/",
        data={"qr_payload": qr_payload},
        format="json",
    )
    assert r.status_code == 400
    assert r.json().get("code") == "photo_required"


@pytest.mark.django_db
def test_qr_preview_returns_operator_snapshot(api_client, operator, qr_payload):
    r = api_client.get(f"/api/attendance/qr-preview/?qr={qr_payload}")
    assert r.status_code == 200
    body = r.json()
    assert body["operator"]["id"] == operator.id
    assert body["operator"]["full_name"] == operator.full_name
    assert body["on_shift"] is False
    assert body["expected_action"] == "check_in"

from __future__ import annotations

import datetime as dt
import json

import pytest
from django.core.files.uploadedfile import SimpleUploadedFile
from django.utils import timezone
from rest_framework.test import APIClient

from apps.attendance.models import AttendanceLog
from apps.audit.models import AuditLog
from apps.livestream.livekit_api import LiveKitUnavailable
from apps.livestream.management.commands.live_ops import live_ops_tick
from apps.livestream.models import (
    LivestreamSession,
    LivestreamSessionStatus,
    LiveSnapshot,
    LiveSnapshotStatus,
)
from apps.operators.models import Operator

from .conftest import ROOM

# Smallest useful JPEG header: SOI + SOF0 (640x480) + EOI.
JPEG = (
    b"\xff\xd8"
    + b"\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00"
    + b"\xff\xc0\x00\x11\x08\x01\xe0\x02\x80\x03\x01\x22\x00\x02\x11\x01\x03\x11\x01"
    + b"\x00" * 64
    + b"\xff\xd9"
)


def _api(user) -> APIClient:
    c = APIClient()
    c.force_authenticate(user)
    return c


def _live(op, *, video=True):
    return LivestreamSession.objects.create(
        operator=op, room_name=ROOM, participant_identity=f"op:{op.id}", participant_sid=f"PA_{op.id}",
        has_video=video, started_at=timezone.now(), status=LivestreamSessionStatus.LIVE)


@pytest.fixture
def m1(make_manager):
    return make_manager("m1")


@pytest.fixture
def live_op(operator, m1):
    operator.managed_by = m1
    operator.save(update_fields=["managed_by"])
    _live(operator)
    return operator


def _request(user, op_id):
    return _api(user).post("/api/live/snapshots/", {"operator_id": op_id}, format="json")


@pytest.mark.django_db
def test_request_sends_both_channels_and_audits(live_op, m1, fake_lk):
    r = _request(m1, live_op.id)
    assert r.status_code == 202, r.content
    snap_id = r.json()["id"]
    assert r.json()["status"] == "pending"
    data_call = next(c for c in fake_lk.calls if c[0] == "send_data")
    assert data_call[1] == ROOM and data_call[2] == [f"op:{live_op.id}"] and data_call[4] == "naff.snapshot"
    assert json.loads(data_call[3]) == {"type": "snapshot", "id": snap_id}
    assert ("set_participant_attributes", ROOM, f"op:{live_op.id}", {"naff.snap": snap_id}) in fake_lk.calls
    assert AuditLog.objects.filter(entity="livestream.LiveSnapshot", entity_id=snap_id, user=m1).exists()


@pytest.mark.django_db
def test_one_channel_is_enough(live_op, m1, fake_lk):
    fake_lk.fail["send_data"] = LiveKitUnavailable("down")
    assert _request(m1, live_op.id).status_code == 202


@pytest.mark.django_db
def test_both_channels_down_is_503_and_row_failed(live_op, m1, fake_lk):
    fake_lk.fail["send_data"] = LiveKitUnavailable("down")
    fake_lk.fail["set_participant_attributes"] = LiveKitUnavailable("down")
    r = _request(m1, live_op.id)
    assert r.status_code == 503 and r.json()["code"] == "unavailable"
    assert LiveSnapshot.objects.get().status == LiveSnapshotStatus.FAILED


@pytest.mark.django_db
def test_not_live_explains_why(operator, m1, fake_lk):
    operator.managed_by = m1
    operator.save(update_fields=["managed_by"])
    r = _request(m1, operator.id)
    assert r.status_code == 409 and r.json()["code"] == "no_shift"
    AttendanceLog.objects.create(operator=operator, checked_in_at=timezone.now())
    assert _request(m1, operator.id).json()["code"] == "offline"
    Operator.objects.filter(pk=operator.pk).update(is_paused=True)
    operator.refresh_from_db()
    assert _request(m1, operator.id).json()["code"] == "paused"
    Operator.objects.filter(pk=operator.pk).update(livestream_enabled=False)
    assert _request(m1, operator.id).json()["code"] == "disabled"
    assert not LiveSnapshot.objects.exists()
    assert not [c for c in fake_lk.calls if c[0] == "send_data"]


@pytest.mark.django_db
def test_live_without_video(operator, m1, fake_lk):
    operator.managed_by = m1
    operator.save(update_fields=["managed_by"])
    _live(operator, video=False)
    assert _request(m1, operator.id).json()["code"] == "no_video"


@pytest.mark.django_db
def test_other_managers_operator_is_hidden(live_op, make_manager, fake_lk):
    other = make_manager("m2")
    assert _request(other, live_op.id).status_code == 404


@pytest.mark.django_db
def test_operator_cannot_request(live_op, operator_user, fake_lk):
    assert _request(operator_user, live_op.id).status_code == 403


@pytest.mark.django_db
def test_cooldown(live_op, m1, fake_lk):
    assert _request(m1, live_op.id).status_code == 202
    r = _request(m1, live_op.id)
    assert r.status_code == 429 and r.json()["code"] == "too_often"


@pytest.mark.django_db
def test_upload_then_manager_gets_the_jpeg(live_op, m1, operator_user, fake_lk):
    snap_id = _request(m1, live_op.id).json()["id"]
    up = _api(operator_user).post(
        f"/api/live/snapshots/{snap_id}/upload/",
        {"image": SimpleUploadedFile("s.jpg", JPEG, content_type="image/jpeg")},
        format="multipart",
    )
    assert up.status_code == 200 and up.json()["status"] == "done"
    d = _api(m1).get(f"/api/live/snapshots/{snap_id}/").json()
    assert d["status"] == "done" and (d["width"], d["height"]) == (640, 480)
    assert d["operator_name"] == live_op.full_name and d["taken_at"]
    img = _api(m1).get(f"/api/live/snapshots/{snap_id}/image/")
    assert img.status_code == 200 and img["Content-Type"] == "image/jpeg"
    assert img.content == JPEG
    # Second upload: the request is closed.
    again = _api(operator_user).post(
        f"/api/live/snapshots/{snap_id}/upload/",
        {"image": SimpleUploadedFile("s.jpg", JPEG, content_type="image/jpeg")},
        format="multipart",
    )
    assert again.status_code == 409


@pytest.mark.django_db
def test_image_before_upload_is_404(live_op, m1, fake_lk):
    snap_id = _request(m1, live_op.id).json()["id"]
    assert _api(m1).get(f"/api/live/snapshots/{snap_id}/image/").status_code == 404


@pytest.mark.django_db
def test_upload_by_another_operator_is_refused(live_op, m1, fake_lk, django_user_model):
    from apps.users.models import Profile, Role

    other_op = Operator.objects.create(full_name="Other")
    u = django_user_model.objects.create_user(username="op2", password="pwd")
    Profile.objects.create(user=u, role=Role.OPERATOR, operator=other_op)
    snap_id = _request(m1, live_op.id).json()["id"]
    r = _api(u).post(
        f"/api/live/snapshots/{snap_id}/upload/",
        {"image": SimpleUploadedFile("s.jpg", JPEG, content_type="image/jpeg")},
        format="multipart",
    )
    assert r.status_code == 403
    assert LiveSnapshot.objects.get().status == LiveSnapshotStatus.PENDING


@pytest.mark.django_db
def test_upload_rejects_non_jpeg_and_late(live_op, m1, operator_user, fake_lk):
    snap_id = _request(m1, live_op.id).json()["id"]
    bad = _api(operator_user).post(
        f"/api/live/snapshots/{snap_id}/upload/",
        {"image": SimpleUploadedFile("s.png", b"\x89PNG....", content_type="image/png")},
        format="multipart",
    )
    assert bad.status_code == 400 and bad.json()["code"] == "bad_image"
    LiveSnapshot.objects.filter(pk=snap_id).update(created_at=timezone.now() - dt.timedelta(minutes=2))
    late = _api(operator_user).post(
        f"/api/live/snapshots/{snap_id}/upload/",
        {"image": SimpleUploadedFile("s.jpg", JPEG, content_type="image/jpeg")},
        format="multipart",
    )
    assert late.status_code == 409 and late.json()["code"] == "expired"
    assert LiveSnapshot.objects.get().status == LiveSnapshotStatus.EXPIRED


@pytest.mark.django_db
def test_publisher_reports_error(live_op, m1, operator_user, fake_lk):
    snap_id = _request(m1, live_op.id).json()["id"]
    r = _api(operator_user).post(
        f"/api/live/snapshots/{snap_id}/upload/", {"error": "no camera track"}, format="json"
    )
    assert r.status_code == 200 and r.json()["status"] == "failed"
    d = _api(m1).get(f"/api/live/snapshots/{snap_id}/").json()
    assert d["status"] == "failed" and d["error"] == "no camera track"


@pytest.mark.django_db
def test_live_ops_expires_and_prunes(live_op, m1, fake_lk):
    snap_id = _request(m1, live_op.id).json()["id"]
    LiveSnapshot.objects.filter(pk=snap_id).update(created_at=timezone.now() - dt.timedelta(minutes=2))
    old = LiveSnapshot.objects.create(operator=live_op, status=LiveSnapshotStatus.DONE, image=JPEG)
    LiveSnapshot.objects.filter(pk=old.pk).update(created_at=timezone.now() - dt.timedelta(days=8))
    stats = live_ops_tick(housekeeping=True)
    assert stats["snapshots_expired"] == 1 and stats["snapshots_pruned"] == 1
    assert LiveSnapshot.objects.get().status == LiveSnapshotStatus.EXPIRED

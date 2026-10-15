from __future__ import annotations

import pytest
from django.utils import timezone
from rest_framework.test import APIClient

from apps.attendance.models import AttendanceLog
from apps.audit.models import AuditLog
from apps.livestream.models import LivestreamSession, LivestreamSessionStatus, RecordingSession
from apps.operators.models import Operator
from apps.operators.services import operator_set_paused, operator_update
from apps.system_settings.models import SystemSetting

from .conftest import ROOM, participant


def _api(user) -> APIClient:
    c = APIClient()
    c.force_authenticate(user)
    return c


@pytest.fixture
def team(make_manager):
    """Two managers, one operator each."""
    m1, m2 = make_manager("m1"), make_manager("m2")
    op1 = Operator.objects.create(full_name="Aziza", livestream_enabled=True, managed_by=m1)
    op2 = Operator.objects.create(full_name="Bobur", livestream_enabled=True, managed_by=m2)
    return m1, m2, op1, op2


def _live(op, sid):
    return LivestreamSession.objects.create(
        operator=op, room_name=ROOM, participant_identity=f"op:{op.id}", participant_sid=sid,
        has_video=True, started_at=timezone.now(), status=LivestreamSessionStatus.LIVE)


@pytest.mark.django_db
def test_live_now_is_scoped_and_explains_who_is_off(team, no_lk):
    m1, m2, op1, op2 = team
    _live(op2, "PA_2")
    op3 = Operator.objects.create(full_name="Cyrus", livestream_enabled=True, managed_by=m1, is_paused=True)
    op4 = Operator.objects.create(full_name="Dilya", livestream_enabled=True, managed_by=m1)
    AttendanceLog.objects.create(operator=op4, checked_in_at=timezone.now())

    data = _api(m1).get("/api/live/live-now/").json()
    assert data["source"] == "db" and data["room_name"] == ROOM
    assert data["live_now"] == []  # op2 belongs to m2
    reasons = {r["id"]: r["reason"] for r in data["enabled_operators"]}
    assert reasons == {op1.id: "no_shift", op3.id: "paused", op4.id: "offline"}

    data2 = _api(m2).get("/api/live/live-now/").json()
    assert [r["operator_id"] for r in data2["live_now"]] == [op2.id]
    assert data2["live_now"][0]["has_video"] is True


@pytest.mark.django_db
def test_live_now_reconciles_with_livekit(team, fake_lk):
    m1, _, op1, _ = team
    fake_lk.participants = [participant(op1.id, "PA_1")]
    data = _api(m1).get("/api/live/live-now/").json()
    assert data["source"] == "livekit"
    assert [r["operator_id"] for r in data["live_now"]] == [op1.id]
    # Cached: a second poll does not hit LiveKit again.
    _api(m1).get("/api/live/live-now/")
    assert [c[0] for c in fake_lk.calls].count("list_participants") == 1


@pytest.mark.django_db
def test_operator_cannot_read_live_now(operator_user):
    assert _api(operator_user).get("/api/live/live-now/").status_code == 403


@pytest.mark.django_db
def test_recordings_are_scoped_and_paged(team):
    m1, _m2, op1, op2 = team
    for i in range(3):
        RecordingSession.objects.create(egress_id=f"EG_{i}", room_name=ROOM, operator=op1, status="finished",
                                        started_at=timezone.now(), s3_bucket="b", s3_key=f"k{i}")
    foreign = RecordingSession.objects.create(egress_id="EG_x", room_name=ROOM, operator=op2, status="finished",
                                              started_at=timezone.now(), s3_bucket="b", s3_key="kx")
    page = _api(m1).get("/api/live/recordings/?limit=2&offset=0").json()
    assert page["count"] == 3 and len(page["results"]) == 2
    assert _api(m1).get(f"/api/live/recordings/{foreign.id}/url/").status_code == 404
    assert _api(m1).get(f"/api/live/recordings/?operator_id={op2.id}").json()["count"] == 0


@pytest.mark.django_db
def test_killswitch_parses_bool_audits_and_kicks(team, fake_lk, django_capture_on_commit_callbacks):
    m1, _, op1, _ = team
    fake_lk.participants = [participant(op1.id, "PA_1")]
    with django_capture_on_commit_callbacks(execute=True):
        resp = _api(m1).patch("/api/live/global-status/", {"enabled": "false"}, format="json")
    assert resp.status_code == 200 and resp.json() == {"enabled": False}
    assert SystemSetting.get_solo().livestream_global_enabled is False
    assert ("remove_participant", ROOM, f"op:{op1.id}") in fake_lk.calls
    assert AuditLog.objects.filter(entity="system_settings.SystemSetting").count() == 1

    assert _api(m1).patch("/api/live/global-status/", {"enabled": "maybe"}, format="json").status_code == 400
    with django_capture_on_commit_callbacks(execute=True):
        _api(m1).patch("/api/live/global-status/", {"enabled": True}, format="json")
    assert SystemSetting.get_solo().livestream_global_enabled is True
    assert [c[0] for c in fake_lk.calls].count("remove_participant") == 1


@pytest.mark.django_db
def test_operator_gets_503_when_killswitch_off(operator_user):
    s = SystemSetting.get_solo()
    s.livestream_global_enabled = False
    s.save()
    resp = _api(operator_user).post("/api/live/room-token/")
    assert resp.status_code == 503 and resp.json()["code"] == "livestream_global_disabled"


@pytest.mark.django_db
def test_config_endpoint(operator_user):
    data = _api(operator_user).get("/api/live/config/").json()
    assert data == {"configured": True, "recording_enabled": True, "room_name": ROOM, "retention_days": 30}


# --- kick hooks -------------------------------------------------------------------


@pytest.mark.django_db
@pytest.mark.parametrize("action", ["pause", "flag_off", "deactivate"])
def test_kick_hooks(operator, fake_lk, django_capture_on_commit_callbacks, action):
    fake_lk.participants = [participant(operator.id, "PA_1")]
    with django_capture_on_commit_callbacks(execute=True):
        if action == "pause":
            operator_set_paused(operator=operator, paused=True, reason="checkout")
        elif action == "flag_off":
            operator_update(operator=operator, livestream_enabled=False)
        else:
            operator_update(operator=operator, status="inactive")
    assert ("remove_participant", ROOM, f"op:{operator.id}") in fake_lk.calls


@pytest.mark.django_db
def test_kick_never_breaks_the_caller(operator, fake_lk, django_capture_on_commit_callbacks):
    fake_lk.fail["remove_participant"] = RuntimeError("livekit down")
    with django_capture_on_commit_callbacks(execute=True):
        operator_set_paused(operator=operator, paused=True, reason="manual")
    operator.refresh_from_db()
    assert operator.is_paused is True


@pytest.mark.django_db
def test_unpause_and_other_updates_do_not_kick(operator, fake_lk, django_capture_on_commit_callbacks):
    with django_capture_on_commit_callbacks(execute=True):
        operator_update(operator=operator, full_name="New name")
        operator_set_paused(operator=operator, paused=False)
    assert not [c for c in fake_lk.calls if c[0] == "remove_participant"]

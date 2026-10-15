from __future__ import annotations

import json

import httpx
import pytest
from django.utils import timezone

from apps.livestream.jwt import b64url_decode
from apps.livestream.livekit_api import LiveKitApiError, LiveKitClient, LiveKitUnavailable, S3Output
from apps.livestream.management.commands.live_ops import live_ops_tick
from apps.livestream.models import LivestreamSession, LivestreamSessionStatus, RecordingSession
from apps.livestream.services import sessions_reconcile

from .conftest import API_KEY, API_SECRET, ROOM, participant


@pytest.mark.django_db
def test_reconcile_opens_missed_and_closes_ghosts(operator):
    ghost = LivestreamSession.objects.create(
        operator=operator, room_name=ROOM, participant_identity=f"op:{operator.id}",
        participant_sid="PA_ghost", started_at=timezone.now(), status=LivestreamSessionStatus.LIVE)
    stats = sessions_reconcile(participants=[participant(operator.id, "PA_real"),
                                             {"sid": "PA_m", "identity": "mgr:1", "state": "ACTIVE"}])
    ghost.refresh_from_db()
    assert ghost.status == LivestreamSessionStatus.LOST
    live = LivestreamSession.objects.get(status=LivestreamSessionStatus.LIVE)
    assert live.participant_sid == "PA_real" and live.has_video and live.video_track_sid == "TR_v1"
    assert stats["opened"] == 1


@pytest.mark.django_db
def test_reconcile_syncs_camera_flag(operator):
    sessions_reconcile(participants=[participant(operator.id, "PA_1")])
    sessions_reconcile(participants=[participant(operator.id, "PA_1", video_sid=None)])
    assert LivestreamSession.objects.get().has_video is False


@pytest.mark.django_db
def test_reconcile_leaves_other_room_alone(operator):
    other = LivestreamSession.objects.create(
        operator=operator, room_name="naffai-demo", participant_identity=f"op:{operator.id}",
        participant_sid="PA_x", started_at=timezone.now(), status=LivestreamSessionStatus.LIVE)
    sessions_reconcile(participants=[])
    other.refresh_from_db()
    assert other.status == LivestreamSessionStatus.LIVE


@pytest.mark.django_db
def test_tick_reconciles_and_records(operator, fake_lk):
    fake_lk.participants = [participant(operator.id, "PA_1")]
    stats = live_ops_tick(housekeeping=True)
    assert stats["reconcile"]["opened"] == 1
    assert stats["started"] == 1
    assert RecordingSession.objects.count() == 1
    assert stats["expired"] == 0 and stats["pruned"] == 0


@pytest.mark.django_db
def test_tick_without_livekit_only_heartbeats(no_lk):
    assert live_ops_tick() == {"configured": False}


# --- HTTP client ---------------------------------------------------------------


def _client(handler) -> LiveKitClient:
    return LiveKitClient(api_url="http://lk:7880/", api_key=API_KEY, api_secret=API_SECRET,
                         transport=httpx.MockTransport(handler))


def test_client_list_participants_sends_admin_token():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["body"] = json.loads(request.content)
        token = request.headers["Authorization"].split(" ", 1)[1]
        seen["claims"] = json.loads(b64url_decode(token.split(".")[1]))
        return httpx.Response(200, json={"participants": [{"sid": "PA_1"}]})

    assert _client(handler).list_participants(ROOM) == [{"sid": "PA_1"}]
    assert seen["url"] == "http://lk:7880/twirp/livekit.RoomService/ListParticipants"
    assert seen["body"] == {"room": ROOM}
    assert seen["claims"]["iss"] == API_KEY
    assert seen["claims"]["video"]["roomAdmin"] is True and seen["claims"]["video"]["room"] == ROOM
    assert seen["claims"]["exp"] - seen["claims"]["nbf"] <= 120


def test_client_not_found_is_soft():
    def handler(request):
        return httpx.Response(404, json={"code": "not_found", "msg": "room not found"})

    c = _client(handler)
    assert c.list_participants(ROOM) == []
    assert c.remove_participant(ROOM, "op:1") is False


def test_client_errors_raise():
    def handler(request):
        return httpx.Response(500, json={"code": "internal", "msg": "boom"})

    with pytest.raises(LiveKitApiError) as exc:
        _client(handler).stop_egress("EG_1")
    assert exc.value.status == 500 and exc.value.code == "internal"

    def down(request):
        raise httpx.ConnectError("refused")

    with pytest.raises(LiveKitUnavailable):
        _client(down).list_egress(active=True)


def test_client_start_track_egress_body():
    seen = {}

    def handler(request):
        seen["url"] = str(request.url)
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json={"egressId": "EG_1", "status": "EGRESS_STARTING"})

    info = _client(handler).start_track_egress(
        room=ROOM, track_id="TR_1", filepath="a/b.mp4",
        s3=S3Output(access_key="AK", secret="SK", region="eu-central-1", bucket="b"))
    assert info["egressId"] == "EG_1"
    assert seen["url"].endswith("/twirp/livekit.Egress/StartTrackEgress")
    assert seen["body"] == {"roomName": ROOM, "trackId": "TR_1", "file": {
        "filepath": "a/b.mp4",
        "s3": {"accessKey": "AK", "secret": "SK", "region": "eu-central-1", "bucket": "b"}}}


def test_client_camelizes_twirp_answers():
    def handler(request):
        return httpx.Response(200, json={"items": [{"egress_id": "EG_1", "room_name": ROOM,
                                                    "file_results": [{"filename": "a.mp4", "started_at": "1"}],
                                                    "track": {"track_id": "TR_1"}}]})

    item = _client(handler).list_egress(egress_id="EG_1")[0]
    assert item == {"egressId": "EG_1", "roomName": ROOM,
                    "fileResults": [{"filename": "a.mp4", "startedAt": "1"}], "track": {"trackId": "TR_1"}}

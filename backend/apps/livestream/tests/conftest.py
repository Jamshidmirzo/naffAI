from __future__ import annotations

import base64
import hashlib
import json
import time
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from django.core.cache import cache

from apps.livestream.jwt import jwt_hs256
from apps.operators.models import Operator
from apps.users.models import Profile, Role

User = get_user_model()

API_KEY = "APIkey12345"
API_SECRET = "secret-123-super-random-string"
ROOM = "naffai-test"


@pytest.fixture(autouse=True)
def lk_settings(settings):
    settings.LIVEKIT_API_KEY = API_KEY
    settings.LIVEKIT_API_SECRET = API_SECRET
    settings.LIVEKIT_WS_URL = "wss://naff.example/livekit/"
    settings.LIVEKIT_ROOM_NAME = ROOM
    settings.LIVEKIT_API_URL = "http://lk"
    settings.LIVEKIT_RECORDING_ENABLED = True
    settings.LIVEKIT_S3_BUCKET = "rec-bucket"
    settings.LIVEKIT_S3_ACCESS_KEY = "AK"
    settings.LIVEKIT_S3_SECRET_KEY = "SK"
    cache.clear()
    yield settings
    cache.clear()


class FakeLiveKitClient:
    """In-memory stand-in for `LiveKitClient`."""

    def __init__(self) -> None:
        self.participants: list[dict[str, Any]] = []
        self.egresses: dict[str, dict[str, Any]] = {}
        self.calls: list[tuple] = []
        self.fail: dict[str, Exception] = {}
        self._n = 0

    def _maybe_fail(self, name: str) -> None:
        if name in self.fail:
            raise self.fail[name]

    def list_participants(self, room):
        self.calls.append(("list_participants", room))
        self._maybe_fail("list_participants")
        return list(self.participants)

    def remove_participant(self, room, identity):
        self.calls.append(("remove_participant", room, identity))
        self._maybe_fail("remove_participant")
        before = len(self.participants)
        self.participants = [p for p in self.participants if p.get("identity") != identity]
        return len(self.participants) != before

    def send_data(self, room, identities, payload, *, topic):
        self.calls.append(("send_data", room, list(identities), payload, topic))
        self._maybe_fail("send_data")

    def set_participant_attributes(self, room, identity, attributes):
        self.calls.append(("set_participant_attributes", room, identity, dict(attributes)))
        self._maybe_fail("set_participant_attributes")

    def start_track_egress(self, *, room, track_id, filepath, s3):
        self.calls.append(("start_track_egress", room, track_id, filepath, s3.bucket))
        self._maybe_fail("start_track_egress")
        self._n += 1
        info = {
            "egressId": f"EG_{self._n}",
            "roomName": room,
            "status": "EGRESS_STARTING",
            "track": {"roomName": room, "trackId": track_id},
        }
        self.egresses[info["egressId"]] = {**info, "status": "EGRESS_ACTIVE"}
        return info

    def stop_egress(self, egress_id):
        self.calls.append(("stop_egress", egress_id))
        self._maybe_fail("stop_egress")
        self.egresses[egress_id]["status"] = "EGRESS_ENDING"
        return self.egresses[egress_id]

    def list_egress(self, *, room="", egress_id="", active=False):
        self.calls.append(("list_egress", room, egress_id, active))
        self._maybe_fail("list_egress")
        items = list(self.egresses.values())
        if egress_id:
            items = [i for i in items if i["egressId"] == egress_id]
        if active:
            items = [i for i in items if i["status"] in ("EGRESS_STARTING", "EGRESS_ACTIVE", "EGRESS_ENDING")]
        return items


@pytest.fixture
def fake_lk(monkeypatch):
    fake = FakeLiveKitClient()
    monkeypatch.setattr("apps.livestream.services.get_livekit_client", lambda: fake)
    monkeypatch.setattr("apps.livestream.livekit_api.get_livekit_client", lambda: fake)
    return fake


@pytest.fixture
def no_lk(monkeypatch):
    monkeypatch.setattr("apps.livestream.services.get_livekit_client", lambda: None)
    monkeypatch.setattr("apps.livestream.livekit_api.get_livekit_client", lambda: None)


def sign_webhook(body: bytes, *, exp_offset: int = 300, sha: bool = True, iss: str = API_KEY,
                 secret: str = API_SECRET) -> str:
    now = int(time.time())
    claims: dict[str, Any] = {"iss": iss, "nbf": now - 1, "exp": now + exp_offset}
    if sha:
        claims["sha256"] = base64.b64encode(hashlib.sha256(body).digest()).decode()
    return jwt_hs256(claims, secret)


def participant(op_id: int, sid: str, *, video_sid: str | None = "TR_v1", joined: int | None = None) -> dict:
    p: dict[str, Any] = {
        "sid": sid,
        "identity": f"op:{op_id}",
        "state": "ACTIVE",
        "joinedAt": str(joined or int(time.time())),
    }
    if video_sid:
        p["tracks"] = [{"sid": video_sid, "type": "VIDEO", "source": "CAMERA"}]
    return p


def event(event_type: str, event_id: str, **extra) -> dict:
    return {"id": event_id, "event": event_type, "room": {"name": ROOM}, **extra}


def body_json(payload: dict) -> bytes:
    return json.dumps(payload).encode()


@pytest.fixture
def operator(db):
    return Operator.objects.create(full_name="Testbonu", livestream_enabled=True)


@pytest.fixture
def operator_user(db, operator):
    u = User.objects.create_user(username="op1", password="pwd")
    Profile.objects.create(user=u, role=Role.OPERATOR, operator=operator)
    return u


@pytest.fixture
def superadmin(db):
    u = User.objects.create_user(username="boss", password="pwd")
    Profile.objects.create(user=u, role=Role.SUPERADMIN)
    return u


@pytest.fixture
def make_manager(db, superadmin):
    def _make(username: str):
        u = User.objects.create_user(username=username, password="pwd")
        Profile.objects.create(user=u, role=Role.MANAGER, reports_to=superadmin)
        return u

    return _make

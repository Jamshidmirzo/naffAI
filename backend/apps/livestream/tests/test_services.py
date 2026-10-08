"""
Unit tests for `apps.livestream.services`.

Covered:
    * JWT shape — header/payload decoded contents, HS256 signature.
    * operator-publisher refusal when `livestream_enabled=False`.
    * webhook signature verification (good & bad).
    * webhook ingestion idempotency on `payload['id']`.
    * participant_joined → opens a LIVE row; participant_left closes it.
    * egress_started / egress_ended lifecycle.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json as _json
import time

import pytest
from django.contrib.auth import get_user_model
from django.test import override_settings

from apps.livestream.models import (
    LiveKitWebhookEvent,
    LivestreamSession,
    LivestreamSessionStatus,
    RecordingSession,
    RecordingSessionStatus,
)
from apps.livestream.services import (
    LivestreamDisabledError,
    LivestreamWebhookError,
    room_token_issue,
    verify_webhook_signature,
    webhook_ingest,
)
from apps.operators.models import Operator
from apps.users.models import Profile, Role

User = get_user_model()


LIVEKIT_OVERRIDES = {
    "LIVEKIT_API_KEY": "APIkey12345",
    "LIVEKIT_API_SECRET": "secret-123-super-random-string",
    "LIVEKIT_WS_URL": "wss://demo.naff.flek.uz/livekit/",
}


@pytest.fixture
def operator(db):
    op = Operator.objects.create(full_name="Testbonu", livestream_enabled=True)
    return op


@pytest.fixture
def operator_disabled(db):
    return Operator.objects.create(
        full_name="Disabled Op", livestream_enabled=False
    )


@pytest.fixture
def operator_user(db, operator):
    u = User.objects.create_user(username="op1", password="pwd")
    Profile.objects.create(user=u, role=Role.OPERATOR, operator=operator)
    return u


@pytest.fixture
def operator_user_disabled(db, operator_disabled):
    u = User.objects.create_user(username="op2", password="pwd")
    Profile.objects.create(user=u, role=Role.OPERATOR, operator=operator_disabled)
    return u


@pytest.fixture
def manager_user(db):
    u = User.objects.create_user(username="mgr", password="pwd")
    Profile.objects.create(user=u, role=Role.MANAGER)
    return u


def _b64url_decode(data: str) -> bytes:
    pad = 4 - (len(data) % 4)
    if pad != 4:
        data += "=" * pad
    return base64.urlsafe_b64decode(data.encode("ascii"))


@override_settings(**LIVEKIT_OVERRIDES)
def test_operator_token_shape(operator_user, operator):
    result = room_token_issue(
        user=operator_user, operator=operator, role="operator"
    )
    assert result.can_publish is True
    assert result.can_subscribe is False
    assert result.participant_identity == f"op:{operator.id}"
    assert result.ws_url == LIVEKIT_OVERRIDES["LIVEKIT_WS_URL"]

    header_b64, payload_b64, sig_b64 = result.token.split(".")
    header = _json.loads(_b64url_decode(header_b64))
    payload = _json.loads(_b64url_decode(payload_b64))
    assert header == {"alg": "HS256", "typ": "JWT"}
    # Signature valid?
    signing_input = f"{header_b64}.{payload_b64}".encode("ascii")
    expected = base64.urlsafe_b64encode(
        hmac.new(
            LIVEKIT_OVERRIDES["LIVEKIT_API_SECRET"].encode("utf-8"),
            signing_input,
            hashlib.sha256,
        ).digest()
    ).rstrip(b"=").decode("ascii")
    assert expected == sig_b64

    assert payload["iss"] == LIVEKIT_OVERRIDES["LIVEKIT_API_KEY"]
    assert payload["sub"] == f"op:{operator.id}"
    assert payload["video"]["canPublish"] is True
    assert payload["video"]["canSubscribe"] is False
    assert "roomAdmin" not in payload["video"]


@override_settings(**LIVEKIT_OVERRIDES)
def test_manager_token_has_room_admin(manager_user):
    result = room_token_issue(user=manager_user, operator=None, role="manager")
    assert result.can_publish is False
    assert result.can_subscribe is True
    _, payload_b64, _ = result.token.split(".")
    payload = _json.loads(_b64url_decode(payload_b64))
    assert payload["video"]["canSubscribe"] is True
    assert payload["video"]["roomAdmin"] is True


@override_settings(**LIVEKIT_OVERRIDES)
def test_operator_token_refused_when_disabled(
    operator_user_disabled, operator_disabled
):
    with pytest.raises(LivestreamDisabledError):
        room_token_issue(
            user=operator_user_disabled,
            operator=operator_disabled,
            role="operator",
        )


@override_settings(**LIVEKIT_OVERRIDES)
def test_webhook_signature_verifies(operator):
    # Build a webhook payload exactly the way LiveKit does — signed JWT
    # in the Authorization header, JSON body is any dict.
    body = _json.dumps(
        {
            "id": "ev-1",
            "event": "participant_joined",
            "room": {"name": "naffai-ops-floor"},
            "participant": {"identity": f"op:{operator.id}"},
        }
    ).encode("utf-8")
    header = base64.urlsafe_b64encode(
        _json.dumps({"alg": "HS256", "typ": "JWT"}).encode("utf-8")
    ).rstrip(b"=").decode("ascii")
    # Any payload; signature is only verified by our code, LiveKit uses
    # it as a transport-level HMAC not a parsed-claim one.
    payload = base64.urlsafe_b64encode(b"{}").rstrip(b"=").decode("ascii")
    signing_input = f"{header}.{payload}".encode("ascii")
    sig = base64.urlsafe_b64encode(
        hmac.new(
            LIVEKIT_OVERRIDES["LIVEKIT_API_SECRET"].encode("utf-8"),
            signing_input,
            hashlib.sha256,
        ).digest()
    ).rstrip(b"=").decode("ascii")
    token = f"{header}.{payload}.{sig}"

    decoded = verify_webhook_signature(raw_body=body, auth_header=token)
    assert decoded["event"] == "participant_joined"


@override_settings(**LIVEKIT_OVERRIDES)
def test_webhook_signature_rejects_bad_sig():
    body = b'{"id": "ev-1", "event": "egress_started"}'
    bad = (
        base64.urlsafe_b64encode(b"{}").rstrip(b"=").decode("ascii")
        + "."
        + base64.urlsafe_b64encode(b"{}").rstrip(b"=").decode("ascii")
        + "."
        + base64.urlsafe_b64encode(b"wrong").rstrip(b"=").decode("ascii")
    )
    with pytest.raises(LivestreamWebhookError):
        verify_webhook_signature(raw_body=body, auth_header=bad)


@pytest.mark.django_db
def test_webhook_ingest_is_idempotent_on_event_id(operator):
    payload = {
        "id": "evt-dup-1",
        "event": "participant_joined",
        "room": {"name": "naffai-ops-floor"},
        "participant": {"identity": f"op:{operator.id}", "joinedAt": int(time.time())},
    }
    first = webhook_ingest(payload=payload)
    assert first["status"] == "ok"
    second = webhook_ingest(payload=payload)
    assert second["status"] == "ignored"
    assert LiveKitWebhookEvent.objects.filter(event_id="evt-dup-1").count() == 1
    assert (
        LivestreamSession.objects.filter(
            participant_identity=f"op:{operator.id}",
            status=LivestreamSessionStatus.LIVE,
        ).count()
        == 1
    )


@pytest.mark.django_db
def test_participant_joined_then_left_closes_session(operator):
    joined = {
        "id": "evt-j",
        "event": "participant_joined",
        "room": {"name": "naffai-ops-floor"},
        "participant": {"identity": f"op:{operator.id}"},
    }
    left = {
        "id": "evt-l",
        "event": "participant_left",
        "participant": {"identity": f"op:{operator.id}"},
    }
    webhook_ingest(payload=joined)
    webhook_ingest(payload=left)
    sess = LivestreamSession.objects.filter(
        participant_identity=f"op:{operator.id}"
    ).first()
    assert sess is not None
    assert sess.status == LivestreamSessionStatus.ENDED
    assert sess.ended_at is not None


@pytest.mark.django_db
def test_egress_started_then_ended_updates_row(operator):
    # Open a live-session first so we FK into it.
    webhook_ingest(
        payload={
            "id": "evt-j2",
            "event": "participant_joined",
            "room": {"name": "naffai-ops-floor"},
            "participant": {"identity": f"op:{operator.id}"},
        }
    )
    egress_payload_start = {
        "id": "evt-eg-start",
        "event": "egress_started",
        "egressInfo": {
            "egressId": "EG_abc",
            "roomName": "naffai-ops-floor",
            "trackComposite": {"identity": f"op:{operator.id}"},
            "startedAt": int(time.time()),
            "file": {"filepath": f"recordings/{operator.id}/foo.mp4"},
        },
    }
    webhook_ingest(payload=egress_payload_start)
    rec = RecordingSession.objects.get(egress_id="EG_abc")
    assert rec.status == RecordingSessionStatus.RECORDING
    assert rec.operator_id == operator.id

    egress_payload_end = {
        "id": "evt-eg-end",
        "event": "egress_ended",
        "egressInfo": {
            "egressId": "EG_abc",
            "status": "EGRESS_COMPLETE",
            "endedAt": int(time.time()) + 60,
            "file": {"duration": 60, "size": 123456},
        },
    }
    webhook_ingest(payload=egress_payload_end)
    rec.refresh_from_db()
    assert rec.status == RecordingSessionStatus.FINISHED
    assert rec.duration_s == 60
    assert rec.size_bytes == 123456

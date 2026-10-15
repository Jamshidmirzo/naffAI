from __future__ import annotations

import pytest
from rest_framework.test import APIClient

from apps.livestream.models import LiveKitWebhookEvent, LivestreamSession, LivestreamSessionStatus
from apps.livestream.services import (
    LivestreamWebhookError,
    verify_webhook_signature,
    webhook_ingest,
)

from .conftest import body_json, event, sign_webhook

URL = "/api/live/webhooks/livekit/"


# --- signature -------------------------------------------------------------


def test_signature_with_body_hash_verifies():
    body = body_json({"id": "EV_1", "event": "room_started"})
    assert verify_webhook_signature(raw_body=body, auth_header=sign_webhook(body))["id"] == "EV_1"


@pytest.mark.parametrize(
    "token_kwargs",
    [
        {"sha": False},
        {"exp_offset": -600},
        {"iss": "someone-else"},
        {"secret": "wrong-secret"},
    ],
)
def test_signature_rejected(token_kwargs):
    body = body_json({"id": "EV_1", "event": "room_started"})
    with pytest.raises(LivestreamWebhookError):
        verify_webhook_signature(raw_body=body, auth_header=sign_webhook(body, **token_kwargs))


def test_captured_header_does_not_sign_another_body():
    signed = body_json({"id": "EV_1", "event": "room_started"})
    forged = body_json({"id": "EV_2", "event": "participant_joined"})
    with pytest.raises(LivestreamWebhookError):
        verify_webhook_signature(raw_body=forged, auth_header=sign_webhook(signed))


def test_alg_none_rejected():
    body = body_json({"id": "EV_1", "event": "room_started"})
    _, payload, _ = sign_webhook(body).split(".")
    none_header = "eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0"  # {"alg":"none","typ":"JWT"}
    with pytest.raises(LivestreamWebhookError):
        verify_webhook_signature(raw_body=body, auth_header=f"{none_header}.{payload}.")


@pytest.mark.django_db
def test_webhook_api_is_not_throttled(settings, operator):
    settings.REST_FRAMEWORK = {
        **settings.REST_FRAMEWORK,
        "DEFAULT_THROTTLE_RATES": {**settings.REST_FRAMEWORK["DEFAULT_THROTTLE_RATES"], "anon": "1/min"},
    }
    client = APIClient()
    for i in range(5):
        body = body_json(event("room_started", f"EV_t{i}"))
        resp = client.post(URL, data=body, content_type="application/json",
                           HTTP_AUTHORIZATION=sign_webhook(body))
        assert resp.status_code == 200, resp.content
    bad = client.post(URL, data=b"{}", content_type="application/json", HTTP_AUTHORIZATION="x.y.z")
    assert bad.status_code == 401


# --- ingestion -------------------------------------------------------------


@pytest.mark.django_db
def test_foreign_room_is_ignored_and_not_stored(operator):
    payload = {"id": "EV_f", "event": "participant_joined", "room": {"name": "naffai-demo"},
               "participant": {"sid": "PA_1", "identity": f"op:{operator.id}"}}
    assert webhook_ingest(payload=payload)["reason"] == "foreign_room"
    assert not LiveKitWebhookEvent.objects.exists()
    assert not LivestreamSession.objects.exists()


@pytest.mark.django_db
def test_duplicate_event_is_ignored(operator):
    payload = event("participant_joined", "EV_d", participant={"sid": "PA_1", "identity": f"op:{operator.id}"})
    assert webhook_ingest(payload=payload)["status"] == "ok"
    assert webhook_ingest(payload=payload)["reason"] == "duplicate"
    assert LivestreamSession.objects.filter(status=LivestreamSessionStatus.LIVE).count() == 1


@pytest.mark.django_db
def test_reconnect_left_of_old_connection_keeps_new_one_live(operator):
    ident = f"op:{operator.id}"
    webhook_ingest(payload=event("participant_joined", "EV_1", participant={"sid": "PA_old", "identity": ident}))
    webhook_ingest(payload=event("participant_joined", "EV_2", participant={"sid": "PA_new", "identity": ident}))
    # The old connection's leave arrives late.
    webhook_ingest(payload=event("participant_left", "EV_3", participant={"sid": "PA_old", "identity": ident}))
    live = LivestreamSession.objects.filter(status=LivestreamSessionStatus.LIVE)
    assert list(live.values_list("participant_sid", flat=True)) == ["PA_new"]


@pytest.mark.django_db
def test_left_stores_disconnect_reason_and_ends(operator):
    ident = f"op:{operator.id}"
    webhook_ingest(payload=event("participant_joined", "EV_1",
                                 participant={"sid": "PA_1", "identity": ident, "joinedAt": "1791977882"}))
    webhook_ingest(payload=event("participant_left", "EV_2", createdAt="1791977999",
                                 participant={"sid": "PA_1", "identity": ident,
                                              "disconnectReason": "CLIENT_INITIATED"}))
    s = LivestreamSession.objects.get()
    assert s.status == LivestreamSessionStatus.ENDED
    assert s.started_at.timestamp() == 1791977882
    assert s.ended_at.timestamp() == 1791977999
    assert s.metadata["disconnect_reason"] == "CLIENT_INITIATED"


@pytest.mark.django_db
def test_track_events_toggle_has_video(operator, no_lk):
    ident = f"op:{operator.id}"
    webhook_ingest(payload=event("participant_joined", "EV_1", participant={"sid": "PA_1", "identity": ident}))
    track = {"sid": "TR_1", "type": "VIDEO", "source": "CAMERA", "mimeType": "video/H264"}
    webhook_ingest(payload=event("track_published", "EV_2", track=track,
                                 participant={"sid": "PA_1", "identity": ident}))
    s = LivestreamSession.objects.get()
    assert s.has_video and s.video_track_sid == "TR_1"
    webhook_ingest(payload=event("track_unpublished", "EV_3", track=track,
                                 participant={"sid": "PA_1", "identity": ident}))
    s.refresh_from_db()
    assert not s.has_video


@pytest.mark.django_db
def test_track_published_without_joined_opens_session(operator, no_lk):
    webhook_ingest(payload=event("track_published", "EV_1",
                                 track={"sid": "TR_1", "type": "VIDEO", "source": "CAMERA"},
                                 participant={"sid": "PA_1", "identity": f"op:{operator.id}"}))
    s = LivestreamSession.objects.get()
    assert s.status == LivestreamSessionStatus.LIVE and s.has_video


@pytest.mark.django_db
def test_room_finished_closes_room(operator):
    webhook_ingest(payload=event("participant_joined", "EV_1",
                                 participant={"sid": "PA_1", "identity": f"op:{operator.id}"}))
    webhook_ingest(payload=event("room_finished", "EV_2"))
    assert LivestreamSession.objects.get().status == LivestreamSessionStatus.ENDED


@pytest.mark.django_db
def test_handler_failure_is_recorded_and_next_event_works(operator, monkeypatch):
    from apps.livestream import services

    def boom(payload):
        raise RuntimeError("boom")

    monkeypatch.setitem(services._HANDLERS, "room_started", boom)
    result = webhook_ingest(payload=event("room_started", "EV_1"))
    assert result["status"] == "failed"
    assert LiveKitWebhookEvent.objects.get(event_id="EV_1").error_text == "boom"
    ok = webhook_ingest(payload=event("participant_joined", "EV_2",
                                      participant={"sid": "PA_1", "identity": f"op:{operator.id}"}))
    assert ok["status"] == "ok"


@pytest.mark.django_db
def test_manager_participant_is_not_a_session(operator):
    webhook_ingest(payload=event("participant_joined", "EV_1", participant={"sid": "PA_m", "identity": "mgr:5"}))
    assert not LivestreamSession.objects.exists()

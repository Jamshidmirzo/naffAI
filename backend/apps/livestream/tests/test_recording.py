from __future__ import annotations

import datetime as dt

import pytest
from django.utils import timezone
from freezegun import freeze_time

from apps.livestream.models import (
    LivestreamSession,
    LivestreamSessionStatus,
    RecordingSession,
    RecordingSessionStatus,
)
from apps.livestream.services import (
    recording_apply_egress_info,
    recording_start,
    recordings_ensure,
    recordings_expire,
    recordings_rotate,
    recordings_sync_active,
    webhook_ingest,
)

from .conftest import ROOM, event


def _live_session(operator, *, sid="PA_1", track="TR_1") -> LivestreamSession:
    return LivestreamSession.objects.create(
        operator=operator, room_name=ROOM, participant_identity=f"op:{operator.id}",
        participant_sid=sid, has_video=True, video_track_sid=track,
        started_at=timezone.now(), status=LivestreamSessionStatus.LIVE,
    )


@pytest.mark.django_db(transaction=True)
def test_track_published_starts_egress_after_commit(operator, fake_lk):
    ident = f"op:{operator.id}"
    webhook_ingest(payload=event("participant_joined", "EV_1", participant={"sid": "PA_1", "identity": ident}))
    webhook_ingest(payload=event("track_published", "EV_2",
                                 track={"sid": "TR_1", "type": "VIDEO", "source": "CAMERA"},
                                 participant={"sid": "PA_1", "identity": ident}))
    starts = [c for c in fake_lk.calls if c[0] == "start_track_egress"]
    assert len(starts) == 1
    _, room, track, filepath, bucket = starts[0]
    assert (room, track, bucket) == (ROOM, "TR_1", "rec-bucket")
    assert filepath.startswith(f"{ROOM}/{operator.id}/") and filepath.endswith("-TR_1.mp4")
    rec = RecordingSession.objects.get()
    assert rec.operator_id == operator.id and rec.track_sid == "TR_1"
    assert rec.s3_key == filepath and rec.status == RecordingSessionStatus.PENDING


@pytest.mark.django_db
def test_recording_disabled_does_nothing(operator, fake_lk, settings):
    settings.LIVEKIT_RECORDING_ENABLED = False
    s = _live_session(operator)
    assert recording_start(session_id=s.id, track_sid="TR_1") is None
    assert not fake_lk.calls


@pytest.mark.django_db
def test_no_second_egress_for_same_track(operator, fake_lk):
    s = _live_session(operator)
    assert recording_start(session_id=s.id, track_sid="TR_1") is not None
    assert recording_start(session_id=s.id, track_sid="TR_1") is None
    assert RecordingSession.objects.count() == 1


@pytest.mark.django_db
def test_failed_starts_back_off_after_three(operator, fake_lk, monkeypatch):
    alerts = []
    monkeypatch.setattr("apps.common.alerts.alert_owner", lambda code, msg, *a, **k: alerts.append(code))
    fake_lk.fail["start_track_egress"] = RuntimeError("not enough cpu")
    s = _live_session(operator)
    for _ in range(5):
        assert recording_start(session_id=s.id, track_sid="TR_1") is None
    assert len([c for c in fake_lk.calls if c[0] == "start_track_egress"]) == 3
    assert RecordingSession.objects.filter(status=RecordingSessionStatus.FAILED).count() == 3
    assert alerts == ["live_egress_failing"]


@pytest.mark.django_db
def test_real_egress_payloads_finish_row(operator, fake_lk):
    s = _live_session(operator)
    rec = recording_start(session_id=s.id, track_sid="TR_1")
    webhook_ingest(payload={"id": "EV_a", "event": "egress_started", "egressInfo": {
        "egressId": rec.egress_id, "roomName": ROOM, "status": "EGRESS_ACTIVE",
        "startedAt": "1791977882000000000", "track": {"roomName": ROOM, "trackId": "TR_1"}}})
    rec.refresh_from_db()
    assert rec.status == RecordingSessionStatus.RECORDING
    webhook_ingest(payload={"id": "EV_b", "event": "egress_ended", "egressInfo": {
        "egressId": rec.egress_id, "roomName": ROOM, "status": "EGRESS_COMPLETE",
        "startedAt": "1791977882000000000", "endedAt": "1791981482000000000",
        "track": {"roomName": ROOM, "trackId": "TR_1"},
        "fileResults": [{"filename": "naffai-test/1/x.mp4", "duration": "3600000000000",
                         "size": "73400320", "location": "https://s3/x.mp4"}]}})
    # A late egress_updated must not move it back.
    webhook_ingest(payload={"id": "EV_c", "event": "egress_updated", "egressInfo": {
        "egressId": rec.egress_id, "roomName": ROOM, "status": "EGRESS_ACTIVE"}})
    rec.refresh_from_db()
    assert rec.status == RecordingSessionStatus.FINISHED
    assert rec.duration_s == 3600 and rec.size_bytes == 73400320
    assert rec.ended_at.timestamp() == 1791981482
    assert rec.s3_key.endswith("-TR_1.mp4")  # our key is kept


@pytest.mark.django_db
def test_egress_event_before_our_row_maps_operator_by_track(operator):
    _live_session(operator, track="TR_9")
    row = recording_apply_egress_info(info={"egressId": "EG_x", "roomName": ROOM, "status": "EGRESS_FAILED",
                                            "error": "boom", "track": {"trackId": "TR_9"}})
    assert row.operator_id == operator.id and row.status == RecordingSessionStatus.FAILED
    assert row.error_text == "boom"


@pytest.mark.django_db
def test_rotation_stops_old_chunk_and_ensure_starts_next(operator, fake_lk):
    s = _live_session(operator)
    with freeze_time(timezone.now() - dt.timedelta(minutes=61)):
        rec = recording_start(session_id=s.id, track_sid="TR_1")
    RecordingSession.objects.filter(pk=rec.pk).update(status=RecordingSessionStatus.RECORDING)
    assert recordings_rotate(max_age_minutes=60) == 1
    assert ("stop_egress", rec.egress_id) in fake_lk.calls
    assert recordings_ensure() == 1
    assert RecordingSession.objects.count() == 2
    # Nothing more to do in the same tick.
    assert recordings_rotate(max_age_minutes=60) == 0
    assert recordings_ensure() == 0


@pytest.mark.django_db
def test_sync_active_settles_lost_egress(operator, fake_lk):
    s = _live_session(operator)
    rec = recording_start(session_id=s.id, track_sid="TR_1")
    fake_lk.egresses[rec.egress_id].update(
        status="EGRESS_COMPLETE", endedAt="1791981482000000000",
        fileResults=[{"filename": "f.mp4", "size": "10", "duration": "5000000000"}])
    assert recordings_sync_active() == 1
    rec.refresh_from_db()
    assert rec.status == RecordingSessionStatus.FINISHED and rec.duration_s == 5
    # Vanished egress → failed.
    rec2 = RecordingSession.objects.create(egress_id="EG_gone", room_name=ROOM, operator=operator,
                                           status=RecordingSessionStatus.RECORDING, started_at=timezone.now())
    recordings_sync_active()
    rec2.refresh_from_db()
    assert rec2.status == RecordingSessionStatus.FAILED and rec2.error_text == "egress lost"


@pytest.mark.django_db
def test_expire_marks_old_recordings_deleted(operator):
    old = RecordingSession.objects.create(egress_id="EG_old", room_name=ROOM, operator=operator,
                                          status=RecordingSessionStatus.FINISHED,
                                          ended_at=timezone.now() - dt.timedelta(days=31))
    new = RecordingSession.objects.create(egress_id="EG_new", room_name=ROOM, operator=operator,
                                          status=RecordingSessionStatus.FINISHED, ended_at=timezone.now())
    assert recordings_expire(retention_days=30) == 1
    old.refresh_from_db()
    new.refresh_from_db()
    assert old.status == RecordingSessionStatus.DELETED and old.deleted_at
    assert new.status == RecordingSessionStatus.FINISHED

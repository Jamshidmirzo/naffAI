"""
Write-side services for operator livestream.

HackSoft shape:
    * APIs stay thin (only parsing / permission). All business writes
      happen here, in named functions that return the new / mutated row.
    * No signals — webhook ingestion is explicit so we can trace it.
    * No fat-model logic — models.py is data shapes only.

Who is live is driven by LiveKit webhooks and reconciled against the
server's participant list (`sessions_reconcile`, run by `live_ops` and by
the live-now API), so a lost webhook never leaves a ghost tile for long.
Calls to LiveKit (kick, egress) never raise into the caller's flow.
"""

from __future__ import annotations

import base64
import datetime as _dt
import hashlib
import hmac
import json as _json
import logging
import secrets
import time
from dataclasses import dataclass
from typing import Any

from django.conf import settings
from django.core.cache import cache
from django.db import IntegrityError, transaction
from django.utils import timezone

from apps.operators.models import Operator, OperatorStatus

from .jwt import JwtError, jwt_hs256, jwt_hs256_decode
from .livekit_api import LiveKitApiError, S3Output, get_livekit_client
from .models import (
    LiveKitWebhookEvent,
    LivestreamSession,
    LivestreamSessionStatus,
    RecordingSession,
    RecordingSessionStatus,
)

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Config helpers
# ---------------------------------------------------------------------------

def _livekit_config() -> dict[str, str]:
    """Return LiveKit creds from settings. Raises if misconfigured."""
    api_key = getattr(settings, "LIVEKIT_API_KEY", "")
    api_secret = getattr(settings, "LIVEKIT_API_SECRET", "")
    ws_url = getattr(settings, "LIVEKIT_WS_URL", "")
    if not api_key or not api_secret or not ws_url:
        raise LivestreamConfigError(
            "LiveKit is not configured (LIVEKIT_API_KEY / LIVEKIT_API_SECRET / "
            "LIVEKIT_WS_URL must be set in environment)."
        )
    return {"api_key": api_key, "api_secret": api_secret, "ws_url": ws_url}


def room_name() -> str:
    """The LiveKit room of this backend (prod and demo share one server)."""
    return getattr(settings, "LIVEKIT_ROOM_NAME", "") or "naffai-ops-floor"


def recording_enabled() -> bool:
    return bool(getattr(settings, "LIVEKIT_RECORDING_ENABLED", False)) and bool(
        getattr(settings, "LIVEKIT_S3_BUCKET", "")
    )


class LivestreamConfigError(RuntimeError):
    """Raised when the environment is missing LiveKit creds."""


class LivestreamDisabledError(RuntimeError):
    """Raised when operator has `livestream_enabled=False`."""


class LivestreamWebhookError(RuntimeError):
    """Raised when webhook signature / shape is invalid."""


# ---------------------------------------------------------------------------
# Access tokens
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class RoomTokenResult:
    ws_url: str
    room_name: str
    participant_identity: str
    participant_name: str
    token: str
    can_publish: bool
    can_subscribe: bool
    expires_at: _dt.datetime


# Tokens are only needed to join; the publisher refreshes it before expiry
# with a planned reconnect, so 12h covers any shift.
DEFAULT_TOKEN_TTL_SECONDS = 12 * 3600


def room_token_issue(
    *,
    user,
    operator: Operator | None,
    role: str,
    ttl_seconds: int = DEFAULT_TOKEN_TTL_SECONDS,
) -> RoomTokenResult:
    """
    Issue a LiveKit AccessToken for the caller.

    * role=="operator" → publish-only (video), subscribe=False. Refused
      when `livestream_enabled=False` or the operator is paused.
    * role=="manager"  → subscribe-only. Admin actions (kick, recording)
      are done by the backend with its own token, never by a browser.
    """
    cfg = _livekit_config()
    room = room_name()

    if role == "operator":
        if operator is None:
            raise LivestreamDisabledError("Operator profile is not linked to this user.")
        if not operator.livestream_enabled:
            raise LivestreamDisabledError("Livestream is not enabled for this operator.")
        if operator.status == OperatorStatus.INACTIVE:
            raise LivestreamDisabledError("Operator is deactivated.")
        if operator.is_paused:
            raise LivestreamDisabledError(
                "Оператор на паузе — публикация отключена до возобновления смены."
            )
        identity = f"op:{operator.id}"
        name = operator.full_name
        can_publish = True
        can_subscribe = False
    else:
        identity = f"mgr:{user.id}"
        name = (
            getattr(user, "get_full_name", lambda: "")() or user.username or "manager"
        )
        can_publish = False
        can_subscribe = True

    now_ts = int(time.time())
    expires_ts = now_ts + ttl_seconds
    video_grants: dict[str, Any] = {
        "room": room,
        "roomJoin": True,
        "canPublish": can_publish,
        "canSubscribe": can_subscribe,
        "canPublishData": False,
    }
    if can_publish:
        video_grants["canPublishSources"] = ["camera"]
    payload = {
        "iss": cfg["api_key"],
        "nbf": now_ts,
        "exp": expires_ts,
        "jti": secrets.token_urlsafe(12),
        "sub": identity,
        "name": name,
        "video": video_grants,
    }
    return RoomTokenResult(
        ws_url=cfg["ws_url"],
        room_name=room,
        participant_identity=identity,
        participant_name=name,
        token=jwt_hs256(payload, cfg["api_secret"]),
        can_publish=can_publish,
        can_subscribe=can_subscribe,
        expires_at=_dt.datetime.fromtimestamp(expires_ts, tz=_dt.UTC),
    )


# ---------------------------------------------------------------------------
# Webhook verification
# ---------------------------------------------------------------------------

# Clock skew tolerated on exp / nbf of webhook tokens.
_WEBHOOK_LEEWAY_S = 60


def verify_webhook_signature(*, raw_body: bytes, auth_header: str) -> dict[str, Any]:
    """
    LiveKit signs every webhook with a JWT in `Authorization` whose
    `sha256` claim is base64(sha256(body)). We check the signature, the
    issuer, the validity window AND the body hash — a captured header is
    useless with any other body, and useless after it expires.
    """
    if not auth_header:
        raise LivestreamWebhookError("Missing Authorization header on webhook.")
    cfg = _livekit_config()
    token = auth_header.strip()
    if token.lower().startswith("bearer "):
        token = token[7:].strip()
    try:
        claims = jwt_hs256_decode(token, cfg["api_secret"])
    except JwtError as exc:
        raise LivestreamWebhookError(str(exc)) from exc

    if claims.get("iss") != cfg["api_key"]:
        raise LivestreamWebhookError("Webhook token issuer mismatch.")
    now = time.time()
    exp = claims.get("exp")
    if not isinstance(exp, (int, float)) or exp < now - _WEBHOOK_LEEWAY_S:
        raise LivestreamWebhookError("Webhook token expired.")
    nbf = claims.get("nbf")
    if isinstance(nbf, (int, float)) and nbf > now + _WEBHOOK_LEEWAY_S:
        raise LivestreamWebhookError("Webhook token not yet valid.")
    body_sha = base64.b64encode(hashlib.sha256(raw_body).digest()).decode("ascii")
    claimed = claims.get("sha256")
    if not isinstance(claimed, str) or not hmac.compare_digest(claimed, body_sha):
        raise LivestreamWebhookError("Webhook body hash mismatch.")

    try:
        payload = _json.loads(raw_body.decode("utf-8"))
    except Exception as exc:
        raise LivestreamWebhookError(f"Invalid JSON body: {exc}") from exc
    if not isinstance(payload, dict):
        raise LivestreamWebhookError("Webhook body is not a JSON object.")
    return payload


# ---------------------------------------------------------------------------
# Protobuf-JSON helpers (int64 → string, timestamps in s / ms / ns)
# ---------------------------------------------------------------------------

def _lk_int(value: Any) -> int | None:
    if value is None or value == "":
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _lk_ts(value: Any) -> _dt.datetime | None:
    """Unix time in s / ms / ns (number or digit string) or ISO-8601."""
    if value in (None, 0, "", "0"):
        return None
    num = _lk_int(value) if not isinstance(value, float) else value
    if num is not None:
        v = float(num)
        if v > 1e17:
            v /= 1e9  # ns
        elif v > 1e14:
            v /= 1e6  # µs
        elif v > 1e11:
            v /= 1e3  # ms
        try:
            return _dt.datetime.fromtimestamp(v, tz=_dt.UTC)
        except (OverflowError, OSError, ValueError):
            return None
    try:
        parsed = _dt.datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if timezone.is_aware(parsed) else timezone.make_aware(parsed, _dt.UTC)


def _lk_duration_s(value: Any) -> int | None:
    """Egress durations are nanoseconds (negative when the egress was
    stopped before it got an end time — treat as unknown)."""
    ns = _lk_int(value)
    if ns is None or ns <= 0:
        return None
    return int(ns // 1_000_000_000) if ns > 10_000_000 else int(ns)


def _camera_track(tracks: Any) -> dict[str, Any] | None:
    for t in tracks or []:
        if isinstance(t, dict) and t.get("type") == "VIDEO" and t.get("source") == "CAMERA":
            return t
    return None


def _operator_id_from_identity(identity: str) -> int | None:
    if not identity.startswith("op:"):
        return None
    try:
        return int(identity[3:])
    except ValueError:
        return None


# ---------------------------------------------------------------------------
# Webhook ingestion
# ---------------------------------------------------------------------------

def _payload_room(payload: dict[str, Any]) -> str:
    room = payload.get("room") or {}
    egress = payload.get("egressInfo") or {}
    return str(room.get("name") or egress.get("roomName") or "")


def webhook_ingest(*, payload: dict[str, Any]) -> dict[str, Any]:
    """
    Idempotent webhook ingestion. Dedupe on `payload['id']`; events of the
    other environment's room are dropped before anything is stored. A
    handler failure is recorded on the event row and acknowledged (200):
    retries would hit the dedupe row anyway, and `live_ops` heals state.
    """
    event_id = str(payload.get("id") or "").strip()
    event_type = str(payload.get("event") or "").strip()
    if not event_id or not event_type:
        raise LivestreamWebhookError("Webhook payload missing `id` or `event`.")

    room = _payload_room(payload)
    if room and room != room_name():
        return {"status": "ignored", "reason": "foreign_room", "event_id": event_id}

    event, created = LiveKitWebhookEvent.objects.get_or_create(
        event_id=event_id,
        defaults={"event_type": event_type, "room_name": room, "payload": payload},
    )
    if not created:
        return {"status": "ignored", "reason": "duplicate", "event_id": event_id}

    handler = _HANDLERS.get(event_type)
    if handler is None:
        return {"status": "stored", "event_id": event_id, "event_type": event_type}

    try:
        with transaction.atomic():
            handler(payload)
    except Exception as exc:
        logger.exception("livestream webhook handler failed: %s", event_type)
        LiveKitWebhookEvent.objects.filter(pk=event.pk).update(error_text=str(exc)[:2000])
        return {"status": "failed", "event_id": event_id, "error": str(exc)[:300]}

    return {"status": "ok", "event_id": event_id, "event_type": event_type}


def _session_open(
    *,
    operator_id: int,
    identity: str,
    sid: str,
    room: str,
    started_at: _dt.datetime,
    camera: dict[str, Any] | None,
    metadata: dict[str, Any] | None = None,
) -> LivestreamSession | None:
    """Open (or return) the LIVE row of this connection; older connections
    of the same identity are marked lost."""
    if not Operator.objects.filter(pk=operator_id).exists():
        logger.warning("livestream: unknown operator %s", identity)
        return None
    existing = LivestreamSession.objects.filter(
        participant_sid=sid, status=LivestreamSessionStatus.LIVE
    ).first()
    LivestreamSession.objects.filter(
        participant_identity=identity, room_name=room, status=LivestreamSessionStatus.LIVE
    ).exclude(participant_sid=sid).update(status=LivestreamSessionStatus.LOST, ended_at=started_at)
    if existing:
        return existing
    return LivestreamSession.objects.create(
        operator_id=operator_id,
        room_name=room,
        participant_identity=identity,
        participant_sid=sid,
        has_video=camera is not None,
        video_track_sid=str((camera or {}).get("sid") or ""),
        started_at=started_at,
        status=LivestreamSessionStatus.LIVE,
        metadata=metadata or {},
    )


def _handle_participant_joined(payload: dict[str, Any]) -> None:
    participant = payload.get("participant") or {}
    identity = str(participant.get("identity") or "")
    op_id = _operator_id_from_identity(identity)
    if op_id is None:
        return
    _session_open(
        operator_id=op_id,
        identity=identity,
        sid=str(participant.get("sid") or ""),
        room=_payload_room(payload) or room_name(),
        started_at=_lk_ts(participant.get("joinedAt"))
        or _lk_ts(payload.get("createdAt"))
        or timezone.now(),
        camera=_camera_track(participant.get("tracks")),
        metadata={"joined": {k: participant.get(k) for k in ("sid", "name", "joinedAt", "version")}},
    )


def _handle_participant_left(payload: dict[str, Any]) -> None:
    participant = payload.get("participant") or {}
    identity = str(participant.get("identity") or "")
    if _operator_id_from_identity(identity) is None:
        return
    sid = str(participant.get("sid") or "")
    ended_at = _lk_ts(payload.get("createdAt")) or timezone.now()
    qs = LivestreamSession.objects.filter(
        participant_identity=identity, status=LivestreamSessionStatus.LIVE
    )
    # Only this connection — a newer one of the same operator stays live.
    # Rows from before sids were stored match by identity.
    qs = qs.filter(participant_sid=sid) if sid else qs
    for row in qs:
        row.status = LivestreamSessionStatus.ENDED
        row.ended_at = ended_at
        row.has_video = False
        row.metadata = {**(row.metadata or {}), "disconnect_reason": participant.get("disconnectReason") or ""}
        row.save(update_fields=["status", "ended_at", "has_video", "metadata", "updated_at"])


def _handle_track_published(payload: dict[str, Any]) -> None:
    track = payload.get("track") or {}
    if track.get("type") != "VIDEO" or track.get("source") != "CAMERA":
        return
    participant = payload.get("participant") or {}
    identity = str(participant.get("identity") or "")
    op_id = _operator_id_from_identity(identity)
    if op_id is None:
        return
    sid = str(participant.get("sid") or "")
    row = LivestreamSession.objects.filter(
        participant_sid=sid, status=LivestreamSessionStatus.LIVE
    ).first()
    if row is None:
        # participant_joined was lost or is still in flight.
        row = _session_open(
            operator_id=op_id,
            identity=identity,
            sid=sid,
            room=_payload_room(payload) or room_name(),
            started_at=_lk_ts(payload.get("createdAt")) or timezone.now(),
            camera=track,
        )
        if row is None:
            return
    row.has_video = True
    row.video_track_sid = str(track.get("sid") or "")
    row.save(update_fields=["has_video", "video_track_sid", "updated_at"])
    if recording_enabled():
        session_id, track_sid = row.id, row.video_track_sid
        transaction.on_commit(lambda: recording_start(session_id=session_id, track_sid=track_sid))


def _handle_track_unpublished(payload: dict[str, Any]) -> None:
    track = payload.get("track") or {}
    track_sid = str(track.get("sid") or "")
    if not track_sid:
        return
    LivestreamSession.objects.filter(
        video_track_sid=track_sid, status=LivestreamSessionStatus.LIVE
    ).update(has_video=False, updated_at=timezone.now())


def _handle_room_finished(payload: dict[str, Any]) -> None:
    room = _payload_room(payload)
    if not room:
        return
    LivestreamSession.objects.filter(room_name=room, status=LivestreamSessionStatus.LIVE).update(
        status=LivestreamSessionStatus.ENDED,
        ended_at=_lk_ts(payload.get("createdAt")) or timezone.now(),
        has_video=False,
    )


def _handle_egress(payload: dict[str, Any]) -> None:
    info = payload.get("egressInfo") or {}
    if info.get("egressId"):
        recording_apply_egress_info(info=info)


_HANDLERS: dict[str, Any] = {
    "participant_joined": _handle_participant_joined,
    "participant_left": _handle_participant_left,
    "track_published": _handle_track_published,
    "track_unpublished": _handle_track_unpublished,
    "room_finished": _handle_room_finished,
    "egress_started": _handle_egress,
    "egress_updated": _handle_egress,
    "egress_ended": _handle_egress,
}


def webhook_events_prune(*, older_than_days: int) -> int:
    cutoff = timezone.now() - _dt.timedelta(days=older_than_days)
    deleted, _ = LiveKitWebhookEvent.objects.filter(received_at__lt=cutoff).delete()
    return deleted


# ---------------------------------------------------------------------------
# Reconcile with the LiveKit server
# ---------------------------------------------------------------------------

_PARTICIPANTS_CACHE_TTL_S = 10


def _participants_cache_key() -> str:
    return f"livekit:participants:{room_name()}"


def participants_fetch_cached(*, ttl: int = _PARTICIPANTS_CACHE_TTL_S) -> list[dict[str, Any]] | None:
    """
    Participants of our room straight from LiveKit, cached a few seconds
    (every manager's wall polls live-now). None = server not configured or
    unreachable — callers fall back to webhook-driven rows.
    """
    key = _participants_cache_key()
    cached = cache.get(key)
    if cached is not None:
        return cached
    client = get_livekit_client()
    if client is None:
        return None
    try:
        participants = client.list_participants(room_name())
    except LiveKitApiError as exc:
        logger.warning("livekit list_participants failed: %s", exc)
        return None
    cache.set(key, participants, ttl)
    return participants


@transaction.atomic
def sessions_reconcile(*, participants: list[dict[str, Any]]) -> dict[str, int]:
    """
    Make LIVE rows of our room match who is really connected: open rows
    for publishers we missed, close rows whose connection is gone, sync
    the camera flag. Pure DB — the caller fetches `participants`.
    """
    room = room_name()
    now = timezone.now()
    stats = {"opened": 0, "closed": 0, "updated": 0}
    seen: set[str] = set()
    for p in participants:
        identity = str(p.get("identity") or "")
        op_id = _operator_id_from_identity(identity)
        sid = str(p.get("sid") or "")
        if op_id is None or not sid or p.get("state") == "DISCONNECTED":
            continue
        seen.add(sid)
        camera = _camera_track(p.get("tracks"))
        row = LivestreamSession.objects.filter(
            participant_sid=sid, status=LivestreamSessionStatus.LIVE
        ).first()
        if row is None:
            row = _session_open(
                operator_id=op_id,
                identity=identity,
                sid=sid,
                room=room,
                started_at=_lk_ts(p.get("joinedAt")) or now,
                camera=camera,
            )
            if row is not None:
                stats["opened"] += 1
            continue
        has_video = camera is not None and not camera.get("muted")
        track_sid = str((camera or {}).get("sid") or "")
        if row.has_video != has_video or (track_sid and row.video_track_sid != track_sid):
            row.has_video = has_video
            if track_sid:
                row.video_track_sid = track_sid
            row.save(update_fields=["has_video", "video_track_sid", "updated_at"])
            stats["updated"] += 1
    stats["closed"] = (
        LivestreamSession.objects.filter(room_name=room, status=LivestreamSessionStatus.LIVE)
        .exclude(participant_sid__in=seen)
        .update(status=LivestreamSessionStatus.LOST, ended_at=now, has_video=False)
    )
    return stats


# ---------------------------------------------------------------------------
# Kicks and the global killswitch
# ---------------------------------------------------------------------------

def publisher_kick(*, operator_id: int, reason: str) -> bool:
    """Disconnect an operator's publisher. Never raises."""
    client = get_livekit_client()
    if client is None:
        return False
    try:
        removed = client.remove_participant(room_name(), f"op:{operator_id}")
    except Exception as exc:
        logger.warning("livekit kick op:%s (%s) failed: %s", operator_id, reason, exc)
        return False
    if removed:
        logger.info("livekit kicked op:%s (%s)", operator_id, reason)
        cache.delete(_participants_cache_key())
    return removed


def publishers_kick_all(*, reason: str) -> int:
    """Disconnect every operator in our room. Never raises."""
    client = get_livekit_client()
    if client is None:
        return 0
    try:
        identities = [
            str(p.get("identity") or "") for p in client.list_participants(room_name())
        ]
    except Exception as exc:
        logger.warning("livekit kick-all (%s): list failed: %s", reason, exc)
        identities = list(
            LivestreamSession.objects.filter(
                room_name=room_name(), status=LivestreamSessionStatus.LIVE
            ).values_list("participant_identity", flat=True)
        )
    kicked = 0
    for identity in {i for i in identities if i.startswith("op:")}:
        try:
            kicked += int(client.remove_participant(room_name(), identity))
        except Exception as exc:
            logger.warning("livekit kick %s (%s) failed: %s", identity, reason, exc)
    cache.delete(_participants_cache_key())
    return kicked


def publisher_kick_on_commit(*, operator_id: int, reason: str) -> None:
    """Kick once the caller's transaction commits (pause, flag off)."""
    if not getattr(settings, "LIVEKIT_API_URL", ""):
        return
    transaction.on_commit(lambda: publisher_kick(operator_id=operator_id, reason=reason))


@transaction.atomic
def livestream_global_set(*, enabled: bool, user):
    """Global killswitch. Turning it off also kicks every publisher now —
    browsers otherwise notice only on their next poll."""
    from apps.audit.services import AuditAction, audit_log_create
    from apps.system_settings.models import SystemSetting

    s = SystemSetting.get_solo()
    old = s.livestream_global_enabled
    s.livestream_global_enabled = enabled
    s.updated_by = user
    s.save(update_fields=["livestream_global_enabled", "updated_by", "updated_at"])
    if old != enabled:
        audit_log_create(
            user=user,
            action=AuditAction.UPDATE,
            entity="system_settings.SystemSetting",
            entity_id=s.pk,
            changes={"livestream_global_enabled": {"old": old, "new": enabled}},
            comment="Live-эфир включён для всех" if enabled else "Live-эфир выключен для всех",
        )
    if not enabled:
        transaction.on_commit(lambda: publishers_kick_all(reason="killswitch"))
    return s


# ---------------------------------------------------------------------------
# Recording (track egress → S3, hourly chunks)
# ---------------------------------------------------------------------------

_STATUS_RANK = {
    RecordingSessionStatus.PENDING: 0,
    RecordingSessionStatus.RECORDING: 1,
    RecordingSessionStatus.FINISHED: 2,
    RecordingSessionStatus.FAILED: 2,
    RecordingSessionStatus.DELETED: 3,
}
_EGRESS_STATUS = {
    "EGRESS_STARTING": RecordingSessionStatus.PENDING,
    "EGRESS_ACTIVE": RecordingSessionStatus.RECORDING,
    "EGRESS_ENDING": RecordingSessionStatus.RECORDING,
    "EGRESS_COMPLETE": RecordingSessionStatus.FINISHED,
    "EGRESS_LIMIT_REACHED": RecordingSessionStatus.FINISHED,
    "EGRESS_FAILED": RecordingSessionStatus.FAILED,
    "EGRESS_ABORTED": RecordingSessionStatus.FAILED,
}
_ACTIVE_RECORDING = (RecordingSessionStatus.PENDING, RecordingSessionStatus.RECORDING)
# After this many failed starts of one track in 10 minutes we stop trying
# (and tell the owner) instead of hammering egress every tick.
_MAX_FAILED_STARTS = 3


def recording_s3_output() -> S3Output:
    return S3Output(
        access_key=getattr(settings, "LIVEKIT_S3_ACCESS_KEY", "") or "",
        secret=getattr(settings, "LIVEKIT_S3_SECRET_KEY", "") or "",
        region=getattr(settings, "LIVEKIT_S3_REGION", "") or "eu-central-1",
        bucket=getattr(settings, "LIVEKIT_S3_BUCKET", "") or "",
        endpoint=getattr(settings, "LIVEKIT_S3_ENDPOINT", "") or "",
        force_path_style=bool(getattr(settings, "LIVEKIT_S3_FORCE_PATH_STYLE", False)),
    )


def recording_key(*, operator_id: int, track_sid: str, at: _dt.datetime) -> str:
    local = timezone.localtime(at)
    return f"{room_name()}/{operator_id}/{local:%Y-%m-%d}/{local:%H%M%S}-{track_sid}.mp4"


def _recent_failed_starts(track_sid: str) -> int:
    since = timezone.now() - _dt.timedelta(minutes=10)
    return RecordingSession.objects.filter(
        track_sid=track_sid, status=RecordingSessionStatus.FAILED, created_at__gte=since
    ).count()


def recording_start(*, session_id: int, track_sid: str) -> RecordingSession | None:
    """Start a track egress for the session's camera track. Never raises."""
    if not recording_enabled() or not track_sid:
        return None
    client = get_livekit_client()
    if client is None:
        return None
    session = LivestreamSession.objects.filter(
        pk=session_id, status=LivestreamSessionStatus.LIVE, video_track_sid=track_sid
    ).first()
    if session is None:
        return None
    if RecordingSession.objects.filter(
        track_sid=track_sid, status__in=_ACTIVE_RECORDING, stop_requested_at__isnull=True
    ).exists():
        return None
    if _recent_failed_starts(track_sid) >= _MAX_FAILED_STARTS:
        return None

    now = timezone.now()
    s3 = recording_s3_output()
    filepath = recording_key(operator_id=session.operator_id, track_sid=track_sid, at=now)
    try:
        info = client.start_track_egress(
            room=session.room_name, track_id=track_sid, filepath=filepath, s3=s3
        )
    except Exception as exc:
        logger.warning("livekit egress start op:%s %s failed: %s", session.operator_id, track_sid, exc)
        RecordingSession.objects.create(
            livestream_session=session,
            operator_id=session.operator_id,
            room_name=session.room_name,
            participant_identity=session.participant_identity,
            track_sid=track_sid,
            egress_id=f"failed:{secrets.token_hex(8)}",
            status=RecordingSessionStatus.FAILED,
            started_at=now,
            ended_at=now,
            error_text=str(exc)[:2000],
        )
        if _recent_failed_starts(track_sid) >= _MAX_FAILED_STARTS:
            _alert_owner_safe(
                "live_egress_failing",
                f"Запись эфира op:{session.operator_id} не стартует: {str(exc)[:200]}",
            )
        return None

    egress_id = str(info.get("egressId") or "")
    if not egress_id:
        return None
    row, _ = RecordingSession.objects.get_or_create(
        egress_id=egress_id,
        defaults={
            "livestream_session": session,
            "operator_id": session.operator_id,
            "room_name": session.room_name,
            "participant_identity": session.participant_identity,
            "track_sid": track_sid,
            "status": RecordingSessionStatus.PENDING,
            "s3_bucket": s3.bucket,
            "s3_key": filepath,
            "started_at": now,
        },
    )
    # A racing egress_started webhook may have created the row first —
    # fill in what only we know.
    RecordingSession.objects.filter(pk=row.pk).update(
        livestream_session=session,
        operator_id=session.operator_id,
        participant_identity=session.participant_identity,
        track_sid=track_sid,
        s3_bucket=s3.bucket,
    )
    return recording_apply_egress_info(info=info) or row


def _recording_row_create(*, info: dict[str, Any], egress_id: str, track_sid: str, status: str) -> RecordingSession:
    """First sight of an egress (webhook before StartTrackEgress returned, or
    the other way round). Both paths may insert concurrently — the loser of
    the unique(egress_id) race reads the winner's row."""
    session = (
        LivestreamSession.objects.filter(video_track_sid=track_sid).order_by("-started_at").first()
        if track_sid
        else None
    )
    try:
        with transaction.atomic():
            return RecordingSession.objects.create(
                egress_id=egress_id,
                livestream_session=session,
                operator_id=session.operator_id if session else None,
                room_name=str(info.get("roomName") or ""),
                participant_identity=session.participant_identity if session else "",
                track_sid=track_sid,
                status=status,
                s3_bucket=getattr(settings, "LIVEKIT_S3_BUCKET", "") or "",
                started_at=_lk_ts(info.get("startedAt")) or timezone.now(),
            )
    except IntegrityError:
        return RecordingSession.objects.select_for_update().get(egress_id=egress_id)


@transaction.atomic
def recording_apply_egress_info(*, info: dict[str, Any]) -> RecordingSession | None:
    """Sync one EgressInfo (webhook / StartTrackEgress / ListEgress) into
    its row. Status only moves forward; the S3 key is never cleared."""
    egress_id = str(info.get("egressId") or "")
    if not egress_id:
        return None
    track_sid = str((info.get("track") or {}).get("trackId") or "")
    new_status = _EGRESS_STATUS.get(str(info.get("status") or ""), RecordingSessionStatus.PENDING)

    row = RecordingSession.objects.select_for_update().filter(egress_id=egress_id).first()
    if row is None:
        row = _recording_row_create(info=info, egress_id=egress_id, track_sid=track_sid, status=new_status)

    fields: set[str] = set()
    if _STATUS_RANK.get(new_status, 0) > _STATUS_RANK.get(row.status, 0):
        row.status = new_status
        fields.add("status")
    results = info.get("fileResults") or []
    file_res = results[0] if results and isinstance(results[0], dict) else (info.get("file") or {})
    filename = str(file_res.get("filename") or "")
    if filename and not row.s3_key:
        row.s3_key = filename
        fields.add("s3_key")
    size = _lk_int(file_res.get("size"))
    if size:
        row.size_bytes = size
        fields.add("size_bytes")
    duration = _lk_duration_s(file_res.get("duration"))
    if duration:
        row.duration_s = duration
        fields.add("duration_s")
    started = _lk_ts(info.get("startedAt"))
    if started and not row.started_at:
        row.started_at = started
        fields.add("started_at")
    if row.status in (RecordingSessionStatus.FINISHED, RecordingSessionStatus.FAILED):
        ended = _lk_ts(info.get("endedAt")) or row.ended_at or timezone.now()
        if row.ended_at != ended:
            row.ended_at = ended
            fields.add("ended_at")
        if not row.duration_s and row.started_at and ended > row.started_at:
            row.duration_s = int((ended - row.started_at).total_seconds())
            fields.add("duration_s")
    error = str(info.get("error") or "")
    if error and not row.error_text:
        row.error_text = error[:2000]
        fields.add("error_text")
    if fields:
        row.save(update_fields=[*fields, "updated_at"])
    return row


def recordings_rotate(*, max_age_minutes: int) -> int:
    """Stop egresses older than the chunk length; `recordings_ensure`
    starts the next chunk in the same tick."""
    client = get_livekit_client()
    if client is None:
        return 0
    cutoff = timezone.now() - _dt.timedelta(minutes=max_age_minutes)
    stopped = 0
    for row in RecordingSession.objects.filter(
        status=RecordingSessionStatus.RECORDING,
        stop_requested_at__isnull=True,
        started_at__lt=cutoff,
    ):
        try:
            client.stop_egress(row.egress_id)
        except LiveKitApiError as exc:
            # Already gone — sync_active will settle its status.
            logger.warning("livekit stop egress %s failed: %s", row.egress_id, exc)
        RecordingSession.objects.filter(pk=row.pk).update(stop_requested_at=timezone.now())
        stopped += 1
    return stopped


def recordings_ensure() -> int:
    """Every live camera track has an active egress (missed webhooks,
    egress restarts, the next hourly chunk)."""
    if not recording_enabled():
        return 0
    started = 0
    for session in LivestreamSession.objects.filter(
        room_name=room_name(), status=LivestreamSessionStatus.LIVE, has_video=True
    ).exclude(video_track_sid=""):
        if recording_start(session_id=session.id, track_sid=session.video_track_sid):
            started += 1
    return started


def recordings_sync_active() -> int:
    """Our pending/recording rows that LiveKit no longer reports active get
    their final state (an egress_ended webhook may have been lost)."""
    client = get_livekit_client()
    if client is None:
        return 0
    rows = list(RecordingSession.objects.filter(status__in=_ACTIVE_RECORDING, room_name=room_name()))
    if not rows:
        return 0
    try:
        active = {str(i.get("egressId")) for i in client.list_egress(room=room_name(), active=True)}
    except LiveKitApiError as exc:
        logger.warning("livekit list_egress failed: %s", exc)
        return 0
    synced = 0
    for row in rows:
        if row.egress_id in active:
            continue
        try:
            items = client.list_egress(egress_id=row.egress_id)
        except LiveKitApiError as exc:
            logger.warning("livekit list_egress %s failed: %s", row.egress_id, exc)
            continue
        if items:
            recording_apply_egress_info(info=items[0])
        else:
            RecordingSession.objects.filter(pk=row.pk).update(
                status=RecordingSessionStatus.FAILED,
                ended_at=timezone.now(),
                error_text="egress lost",
            )
        synced += 1
    return synced


def recordings_expire(*, retention_days: int) -> int:
    """Mark recordings past retention deleted (the S3 lifecycle rule with
    the same day count removes the objects)."""
    cutoff = timezone.now() - _dt.timedelta(days=retention_days)
    return RecordingSession.objects.filter(
        status=RecordingSessionStatus.FINISHED, ended_at__lt=cutoff
    ).update(status=RecordingSessionStatus.DELETED, deleted_at=timezone.now())


def _alert_owner_safe(key: str, text: str) -> None:
    try:
        from apps.common.alerts import alert_owner

        alert_owner(key, text)
    except Exception as exc:  # pragma: no cover — alerting must never break us
        logger.warning("alert_owner(%s) failed: %s", key, exc)


# ---------------------------------------------------------------------------
# S3 presign for playback
# ---------------------------------------------------------------------------

def recording_presigned_url(*, recording: RecordingSession, expires_in: int = 600) -> str:
    """
    Return a short-lived S3 GET URL for the recording. Raises if the
    recording doesn't have a usable s3_key yet (still recording / failed).
    """
    if recording.status != RecordingSessionStatus.FINISHED:
        raise ValueError("Recording is not finished yet.")
    if not recording.s3_bucket or not recording.s3_key:
        raise ValueError("Recording has no S3 location — egress misconfigured.")

    # Import boto3 lazily so dev envs without AWS creds don't crash
    # on `./manage.py check`.
    try:
        import boto3  # type: ignore[import-not-found]
        from botocore.client import Config  # type: ignore[import-not-found]
    except Exception as exc:
        raise LivestreamConfigError(
            "boto3 is not installed. Add it to pyproject.toml and rebuild."
        ) from exc

    s3 = recording_s3_output()
    client_kwargs: dict[str, Any] = {
        "region_name": s3.region,
        "config": Config(signature_version="s3v4"),
    }
    if s3.access_key and s3.secret:
        client_kwargs["aws_access_key_id"] = s3.access_key
        client_kwargs["aws_secret_access_key"] = s3.secret
    if s3.endpoint:
        client_kwargs["endpoint_url"] = s3.endpoint
    client = boto3.client("s3", **client_kwargs)
    return client.generate_presigned_url(
        "get_object",
        Params={
            "Bucket": recording.s3_bucket,
            "Key": recording.s3_key,
            "ResponseContentType": "video/mp4",
        },
        ExpiresIn=expires_in,
    )

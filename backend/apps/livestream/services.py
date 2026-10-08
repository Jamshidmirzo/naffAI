"""
Write-side services for operator livestream.

HackSoft shape:
    * APIs stay thin (only parsing / permission). All business writes
      happen here, in named functions that return the new / mutated row.
    * No signals — webhook ingestion is explicit so we can trace it.
    * No fat-model logic — models.py is data shapes only.
"""

from __future__ import annotations

import datetime as _dt
import hashlib
import hmac
import logging
import secrets
import time
from dataclasses import dataclass
from typing import Any

from django.conf import settings
from django.db import transaction
from django.utils import timezone

from apps.operators.models import Operator

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

# The LiveKit AccessToken is a JWT with HS256-signed claims. We generate it
# ourselves (no server call needed) — same as the `livekit-server-sdk` libraries
# do — so no runtime SFU-check is involved in issuing a token.

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


class LivestreamConfigError(RuntimeError):
    """Raised when the environment is missing LiveKit creds."""


class LivestreamDisabledError(RuntimeError):
    """Raised when operator has `livestream_enabled=False`."""


class LivestreamWebhookError(RuntimeError):
    """Raised when webhook signature / shape is invalid."""


# ---------------------------------------------------------------------------
# JWT (LiveKit AccessToken format) — manual, no external dep required
# ---------------------------------------------------------------------------

def _b64url(data: bytes) -> str:
    import base64

    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64url_json(obj: Any) -> str:
    import json as _json

    return _b64url(_json.dumps(obj, separators=(",", ":"), sort_keys=True).encode("utf-8"))


def _jwt_hs256(payload: dict[str, Any], secret: str) -> str:
    """
    Compact HS256 JWT. LiveKit tokens are plain JWTs with a `video` claim
    carrying grants (room / can_publish / can_subscribe / etc).
    """
    header = {"alg": "HS256", "typ": "JWT"}
    header_b64 = _b64url_json(header)
    payload_b64 = _b64url_json(payload)
    signing_input = f"{header_b64}.{payload_b64}".encode("ascii")
    sig = hmac.new(secret.encode("utf-8"), signing_input, hashlib.sha256).digest()
    return f"{header_b64}.{payload_b64}.{_b64url(sig)}"


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


# Single global room for the whole call-center — simpler ops and
# LiveKit scales to hundreds of publishers per room out of the box.
DEFAULT_ROOM_NAME = "naffai-ops-floor"
# Tokens are short-lived; publisher-side auto-refresh is handled by the
# LiveKit JS SDK. We use 12h so a reconnection during a long shift
# doesn't fail even if the browser was asleep for a while.
DEFAULT_TOKEN_TTL_SECONDS = 12 * 3600


@transaction.atomic
def room_token_issue(
    *,
    user,
    operator: Operator | None,
    role: str,
    room_name: str | None = None,
    ttl_seconds: int = DEFAULT_TOKEN_TTL_SECONDS,
) -> RoomTokenResult:
    """
    Issue a LiveKit AccessToken for the caller.

    * role=="operator" → publish-only (video+audio tracks), subscribe=False.
      Requires `operator.livestream_enabled=True` or we refuse.
    * role=="manager"  → subscribe-only + room admin (needed to kick a bad
      publisher or request egress on demand).

    Returns the token + WS URL the frontend connects to.
    """
    cfg = _livekit_config()
    room = room_name or DEFAULT_ROOM_NAME

    if role == "operator":
        if operator is None:
            raise LivestreamDisabledError("Operator profile is not linked to this user.")
        if not operator.livestream_enabled:
            raise LivestreamDisabledError("Livestream is not enabled for this operator.")
        if operator.is_paused:
            raise LivestreamDisabledError(
                "Оператор на паузе — публикация отключена до возобновления смены."
            )
        identity = f"op:{operator.id}"
        name = operator.full_name
        can_publish = True
        can_subscribe = False
    else:
        # Manager / super_manager / superadmin — all see the live wall.
        # They never publish; subscribing + roomAdmin + roomRecord give
        # the right of future on-demand egress starts.
        identity = f"mgr:{user.id}"
        name = (
            getattr(user, "get_full_name", lambda: "")() or user.username or "manager"
        )
        can_publish = False
        can_subscribe = True

    now_ts = int(time.time())
    expires_ts = now_ts + ttl_seconds
    jti = secrets.token_urlsafe(12)

    video_grants: dict[str, Any] = {
        "room": room,
        "roomJoin": True,
        "canPublish": can_publish,
        "canSubscribe": can_subscribe,
        "canPublishData": can_publish,
    }
    if role != "operator":
        # Needed for the egress API + /live/wall listing of participants.
        video_grants["roomAdmin"] = True
        video_grants["roomRecord"] = True

    payload = {
        "iss": cfg["api_key"],
        "nbf": now_ts,
        "exp": expires_ts,
        "jti": jti,
        "sub": identity,
        "name": name,
        "video": video_grants,
    }
    token = _jwt_hs256(payload, cfg["api_secret"])

    return RoomTokenResult(
        ws_url=cfg["ws_url"],
        room_name=room,
        participant_identity=identity,
        participant_name=name,
        token=token,
        can_publish=can_publish,
        can_subscribe=can_subscribe,
        expires_at=_dt.datetime.fromtimestamp(expires_ts, tz=_dt.UTC),
    )


# ---------------------------------------------------------------------------
# Webhook ingestion
# ---------------------------------------------------------------------------

def verify_webhook_signature(*, raw_body: bytes, auth_header: str) -> dict[str, Any]:
    """
    LiveKit webhooks ship a signed JWT in the `Authorization` header
    (NOT in the body). The payload sits in the body as JSON. We validate
    the JWT with our API secret and then return the decoded body.

    This mirrors the behaviour of `livekit-server-sdk`'s WebhookReceiver.
    """
    if not auth_header:
        raise LivestreamWebhookError("Missing Authorization header on webhook.")
    cfg = _livekit_config()
    # Strip optional `Bearer ` prefix — LiveKit sends the JWT raw but some
    # proxies prepend the scheme.
    token = auth_header.strip()
    if token.lower().startswith("bearer "):
        token = token[7:]
    parts = token.split(".")
    if len(parts) != 3:
        raise LivestreamWebhookError("Malformed webhook JWT.")
    header_b64, payload_b64, sig_b64 = parts
    signing_input = f"{header_b64}.{payload_b64}".encode("ascii")
    expected = _b64url(
        hmac.new(cfg["api_secret"].encode("utf-8"), signing_input, hashlib.sha256).digest()
    )
    if not hmac.compare_digest(expected, sig_b64):
        raise LivestreamWebhookError("Webhook signature mismatch.")
    # Decode body JSON (webhook payload lives in request body, JWT is only
    # used as auth).
    import json as _json

    try:
        payload = _json.loads(raw_body.decode("utf-8"))
    except Exception as exc:
        raise LivestreamWebhookError(f"Invalid JSON body: {exc}") from exc
    if not isinstance(payload, dict):
        raise LivestreamWebhookError("Webhook body is not a JSON object.")
    return payload


def _parse_livekit_ts(value: Any) -> _dt.datetime | None:
    """LiveKit sends timestamps as either an int-seconds or ISO-8601 string."""
    if value in (None, 0, "", "0"):
        return None
    try:
        if isinstance(value, (int, float)):
            # Treat large numbers as milliseconds (LiveKit uses nanoseconds
            # internally — if value is > 10^13 it must be ns/ms).
            v = float(value)
            if v > 1e15:
                v = v / 1e9  # ns → s
            elif v > 1e12:
                v = v / 1e3  # ms → s
            return _dt.datetime.fromtimestamp(v, tz=_dt.UTC)
        return _dt.datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except Exception:
        return None


def _operator_from_identity(identity: str) -> Operator | None:
    if not identity.startswith("op:"):
        return None
    try:
        return Operator.objects.filter(pk=int(identity[3:])).first()
    except (TypeError, ValueError):
        return None


@transaction.atomic
def webhook_ingest(*, payload: dict[str, Any]) -> dict[str, Any]:
    """
    Idempotent webhook ingestion. Dedupe on `payload['id']` (per-event
    UUID). Returns a short dict for API responses.
    """
    event_id = str(payload.get("id") or "").strip()
    event_type = str(payload.get("event") or "").strip()
    if not event_id or not event_type:
        raise LivestreamWebhookError("Webhook payload missing `id` or `event`.")

    _, created = LiveKitWebhookEvent.objects.get_or_create(
        event_id=event_id,
        defaults={"event_type": event_type, "payload": payload},
    )
    if not created:
        return {"status": "ignored", "reason": "duplicate", "event_id": event_id}

    handler = _HANDLERS.get(event_type)
    if handler is None:
        # Unknown event — stored for audit, not an error.
        return {"status": "stored", "event_id": event_id, "event_type": event_type}

    try:
        handler(payload)
    except Exception as exc:
        logger.exception("livestream webhook handler failed: %s", event_type)
        # Store the failure in the event row for debugging but DON'T
        # re-raise — LiveKit would retry and the dedupe check above would
        # keep seeing the row and we'd spam logs. The failure is visible
        # via the webhook event row (payload is kept).
        return {"status": "failed", "event_id": event_id, "error": str(exc)}

    return {"status": "ok", "event_id": event_id, "event_type": event_type}


def _handle_participant_joined(payload: dict[str, Any]) -> None:
    participant = payload.get("participant") or {}
    room = payload.get("room") or {}
    identity = str(participant.get("identity") or "")
    if not identity.startswith("op:"):
        return
    operator = _operator_from_identity(identity)
    if operator is None:
        logger.warning("participant_joined for unknown operator: %s", identity)
        return
    started_at = (
        _parse_livekit_ts(participant.get("joinedAt"))
        or _parse_livekit_ts(payload.get("createdAt"))
        or timezone.now()
    )
    # Close any stale LIVE row for this identity first (defensive — SFU
    # can lose a participant-left on a crash).
    LivestreamSession.objects.filter(
        participant_identity=identity, status=LivestreamSessionStatus.LIVE
    ).update(status=LivestreamSessionStatus.LOST, ended_at=started_at)
    LivestreamSession.objects.create(
        operator=operator,
        room_name=str(room.get("name") or DEFAULT_ROOM_NAME),
        participant_identity=identity,
        started_at=started_at,
        status=LivestreamSessionStatus.LIVE,
        metadata={"joined": participant},
    )


def _handle_participant_left(payload: dict[str, Any]) -> None:
    participant = payload.get("participant") or {}
    identity = str(participant.get("identity") or "")
    if not identity.startswith("op:"):
        return
    ended_at = _parse_livekit_ts(payload.get("createdAt")) or timezone.now()
    LivestreamSession.objects.filter(
        participant_identity=identity, status=LivestreamSessionStatus.LIVE
    ).update(status=LivestreamSessionStatus.ENDED, ended_at=ended_at)


def _handle_egress_started(payload: dict[str, Any]) -> None:
    info = payload.get("egressInfo") or {}
    egress_id = str(info.get("egressId") or "")
    if not egress_id:
        return
    room_name = str(info.get("roomName") or payload.get("room", {}).get("name") or "")
    identity = ""
    # TrackComposite / RoomComposite — identity lives in different sub-objects.
    for key in ("trackComposite", "track", "participant"):
        req = info.get(key) or {}
        if req.get("identity"):
            identity = str(req["identity"])
            break
    operator = _operator_from_identity(identity) if identity else None
    live_sess = (
        LivestreamSession.objects.filter(
            participant_identity=identity,
            status=LivestreamSessionStatus.LIVE,
        )
        .order_by("-started_at")
        .first()
        if identity
        else None
    )
    s3_bucket = getattr(settings, "LIVEKIT_S3_BUCKET", "") or ""
    s3_key = ""
    # Egress file output — path is in file.filepath / file.location.
    for key in ("file", "fileOutputs", "segmentOutputs"):
        obj = info.get(key)
        if isinstance(obj, dict):
            s3_key = str(obj.get("filepath") or obj.get("location") or "")
            if s3_key:
                break
        if isinstance(obj, list) and obj:
            first = obj[0] or {}
            s3_key = str(first.get("filepath") or first.get("location") or "")
            if s3_key:
                break
    RecordingSession.objects.update_or_create(
        egress_id=egress_id,
        defaults={
            "livestream_session": live_sess,
            "operator": operator,
            "room_name": room_name,
            "participant_identity": identity,
            "status": RecordingSessionStatus.RECORDING,
            "s3_bucket": s3_bucket,
            "s3_key": s3_key,
            "started_at": _parse_livekit_ts(info.get("startedAt")) or timezone.now(),
        },
    )


def _handle_egress_ended(payload: dict[str, Any]) -> None:
    info = payload.get("egressInfo") or {}
    egress_id = str(info.get("egressId") or "")
    if not egress_id:
        return
    status_in = str(info.get("status") or "")
    is_failed = status_in in ("EGRESS_FAILED", "EGRESS_ABORTED")
    duration_s = None
    size_bytes = None
    error_text = str(info.get("error") or "")
    # Many finalization fields live under file.*.
    for key in ("file", "fileOutputs", "segmentOutputs"):
        obj = info.get(key)
        if isinstance(obj, list) and obj:
            obj = obj[0]
        if isinstance(obj, dict):
            if obj.get("duration") is not None:
                try:
                    duration_s = int(obj["duration"]) // (10**9) if obj["duration"] > 10**12 else int(obj["duration"])
                except Exception:
                    duration_s = None
            if obj.get("size") is not None:
                try:
                    size_bytes = int(obj["size"])
                except Exception:
                    size_bytes = None
    ended_at = _parse_livekit_ts(info.get("endedAt")) or timezone.now()
    try:
        row = RecordingSession.objects.get(egress_id=egress_id)
    except RecordingSession.DoesNotExist:
        # Egress_ended came before egress_started (webhooks are concurrent).
        # Rebuild a minimal row.
        row = RecordingSession.objects.create(
            egress_id=egress_id,
            room_name=str(info.get("roomName") or ""),
            participant_identity="",
            status=RecordingSessionStatus.FAILED
            if is_failed
            else RecordingSessionStatus.FINISHED,
            started_at=_parse_livekit_ts(info.get("startedAt")) or ended_at,
            ended_at=ended_at,
            duration_s=duration_s,
            size_bytes=size_bytes,
            error_text=error_text,
        )
        return
    row.status = (
        RecordingSessionStatus.FAILED if is_failed else RecordingSessionStatus.FINISHED
    )
    row.ended_at = ended_at
    row.duration_s = duration_s or row.duration_s
    row.size_bytes = size_bytes or row.size_bytes
    row.error_text = error_text or row.error_text
    row.save(
        update_fields=["status", "ended_at", "duration_s", "size_bytes", "error_text", "updated_at"]
    )


_HANDLERS: dict[str, Any] = {
    "participant_joined": _handle_participant_joined,
    "participant_left": _handle_participant_left,
    "egress_started": _handle_egress_started,
    "egress_updated": _handle_egress_started,  # same shape — just resync
    "egress_ended": _handle_egress_ended,
}


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

    region = getattr(settings, "LIVEKIT_S3_REGION", "") or "eu-central-1"
    access_key = getattr(settings, "LIVEKIT_S3_ACCESS_KEY", "") or ""
    secret_key = getattr(settings, "LIVEKIT_S3_SECRET_KEY", "") or ""
    endpoint_url = getattr(settings, "LIVEKIT_S3_ENDPOINT", "") or None

    client_kwargs: dict[str, Any] = {
        "region_name": region,
        "config": Config(signature_version="s3v4"),
    }
    if access_key and secret_key:
        client_kwargs["aws_access_key_id"] = access_key
        client_kwargs["aws_secret_access_key"] = secret_key
    if endpoint_url:
        client_kwargs["endpoint_url"] = endpoint_url
    client = boto3.client("s3", **client_kwargs)
    return client.generate_presigned_url(
        "get_object",
        Params={"Bucket": recording.s3_bucket, "Key": recording.s3_key},
        ExpiresIn=expires_in,
    )

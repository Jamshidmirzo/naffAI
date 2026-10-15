"""
Thin client for the LiveKit server API (Twirp over HTTP + JSON).

Used by the backend for everything a browser must not be trusted with:
listing who is really in the room, kicking a publisher (killswitch,
pause, flag off) and starting / stopping track egress (recording).

Responses are protobuf-JSON: camelCase keys, int64 as strings, enums as
names — parsing helpers live in `services`.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from typing import Any

import httpx
from django.conf import settings

from .jwt import jwt_hs256

logger = logging.getLogger(__name__)


class LiveKitApiError(RuntimeError):
    def __init__(self, msg: str, *, status: int = 0, code: str = "") -> None:
        super().__init__(msg)
        self.status = status
        self.code = code


class LiveKitUnavailable(LiveKitApiError):
    """Server unreachable / timed out."""


@dataclass(frozen=True)
class S3Output:
    access_key: str
    secret: str
    region: str
    bucket: str
    endpoint: str = ""
    force_path_style: bool = False

    def as_proto(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "accessKey": self.access_key,
            "secret": self.secret,
            "region": self.region,
            "bucket": self.bucket,
        }
        if self.endpoint:
            out["endpoint"] = self.endpoint
        if self.force_path_style:
            out["forcePathStyle"] = True
        return out


class LiveKitClient:
    def __init__(
        self,
        *,
        api_url: str,
        api_key: str,
        api_secret: str,
        timeout: float = 5.0,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self.api_url = api_url.rstrip("/")
        self.api_key = api_key
        self.api_secret = api_secret
        self.timeout = timeout
        self.transport = transport

    def _admin_token(self, room: str = "") -> str:
        now = int(time.time())
        video: dict[str, Any] = {"roomAdmin": True, "roomList": True, "roomRecord": True}
        if room:
            video["room"] = room
        return jwt_hs256(
            {"iss": self.api_key, "nbf": now - 5, "exp": now + 60, "sub": "naffai-backend", "video": video},
            self.api_secret,
        )

    def _twirp(self, service: str, method: str, body: dict[str, Any], *, room: str = "") -> dict[str, Any]:
        url = f"{self.api_url}/twirp/livekit.{service}/{method}"
        headers = {"Authorization": f"Bearer {self._admin_token(room)}"}
        try:
            with httpx.Client(timeout=self.timeout, transport=self.transport) as client:
                resp = client.post(url, json=body, headers=headers)
        except httpx.HTTPError as exc:
            raise LiveKitUnavailable(f"{service}/{method}: {exc}") from exc
        if resp.status_code >= 400:
            code, msg = "", resp.text[:300]
            try:
                data = resp.json()
                code, msg = str(data.get("code") or ""), str(data.get("msg") or msg)
            except ValueError:
                pass
            raise LiveKitApiError(f"{service}/{method}: {msg}", status=resp.status_code, code=code)
        try:
            data = resp.json()
        except ValueError:
            return {}
        return data if isinstance(data, dict) else {}

    # --- RoomService -------------------------------------------------------

    def list_participants(self, room: str) -> list[dict[str, Any]]:
        try:
            data = self._twirp("RoomService", "ListParticipants", {"room": room}, room=room)
        except LiveKitApiError as exc:
            # Room not created yet (nobody joined since the last empty_timeout).
            if exc.code == "not_found":
                return []
            raise
        return list(data.get("participants") or [])

    def remove_participant(self, room: str, identity: str) -> bool:
        """True if removed, False if they were not in the room."""
        try:
            self._twirp("RoomService", "RemoveParticipant", {"room": room, "identity": identity}, room=room)
        except LiveKitApiError as exc:
            if exc.code == "not_found":
                return False
            raise
        return True

    # --- Egress --------------------------------------------------------------

    def start_track_egress(self, *, room: str, track_id: str, filepath: str, s3: S3Output) -> dict[str, Any]:
        body = {
            "roomName": room,
            "trackId": track_id,
            "file": {"filepath": filepath, "s3": s3.as_proto()},
        }
        return self._twirp("Egress", "StartTrackEgress", body, room=room)

    def stop_egress(self, egress_id: str) -> dict[str, Any]:
        return self._twirp("Egress", "StopEgress", {"egressId": egress_id})

    def list_egress(self, *, room: str = "", egress_id: str = "", active: bool = False) -> list[dict[str, Any]]:
        body: dict[str, Any] = {}
        if room:
            body["roomName"] = room
        if egress_id:
            body["egressId"] = egress_id
        if active:
            body["active"] = True
        return list(self._twirp("Egress", "ListEgress", body, room=room).get("items") or [])


def get_livekit_client() -> LiveKitClient | None:
    """None when the server API is not configured (dev, tests, old envs)."""
    api_url = getattr(settings, "LIVEKIT_API_URL", "") or ""
    api_key = getattr(settings, "LIVEKIT_API_KEY", "") or ""
    api_secret = getattr(settings, "LIVEKIT_API_SECRET", "") or ""
    if not (api_url and api_key and api_secret):
        return None
    return LiveKitClient(api_url=api_url, api_key=api_key, api_secret=api_secret)

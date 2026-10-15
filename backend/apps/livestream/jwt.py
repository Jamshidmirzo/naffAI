"""
Minimal HS256 JWT for LiveKit — access tokens we sign and webhook tokens
LiveKit signs for us. Kept dependency-free and separate from `services`
so the server-API client (`livekit_api`) can sign without import cycles.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
from typing import Any


class JwtError(ValueError):
    """Malformed token, wrong algorithm or bad signature."""


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def b64url_decode(data: str) -> bytes:
    pad = -len(data) % 4
    return base64.urlsafe_b64decode((data + "=" * pad).encode("ascii"))


def _b64url_json(obj: Any) -> str:
    return b64url(json.dumps(obj, separators=(",", ":"), sort_keys=True).encode("utf-8"))


def _sign(signing_input: bytes, secret: str) -> str:
    return b64url(hmac.new(secret.encode("utf-8"), signing_input, hashlib.sha256).digest())


def jwt_hs256(payload: dict[str, Any], secret: str) -> str:
    """Compact HS256 JWT (LiveKit grants live in the `video` claim)."""
    header_b64 = _b64url_json({"alg": "HS256", "typ": "JWT"})
    payload_b64 = _b64url_json(payload)
    signing_input = f"{header_b64}.{payload_b64}".encode("ascii")
    return f"{header_b64}.{payload_b64}.{_sign(signing_input, secret)}"


def jwt_hs256_decode(token: str, secret: str) -> dict[str, Any]:
    """
    Verify an HS256 token and return its claims. Only the signature and
    the algorithm are checked here — callers check exp / iss / custom
    claims themselves.
    """
    parts = token.split(".")
    if len(parts) != 3:
        raise JwtError("Malformed JWT.")
    header_b64, payload_b64, sig_b64 = parts
    try:
        header = json.loads(b64url_decode(header_b64))
    except Exception as exc:
        raise JwtError("Malformed JWT header.") from exc
    if not isinstance(header, dict) or header.get("alg") != "HS256":
        raise JwtError("Unsupported JWT algorithm.")
    expected = _sign(f"{header_b64}.{payload_b64}".encode("ascii"), secret)
    if not hmac.compare_digest(expected, sig_b64):
        raise JwtError("JWT signature mismatch.")
    try:
        claims = json.loads(b64url_decode(payload_b64))
    except Exception as exc:
        raise JwtError("Malformed JWT payload.") from exc
    if not isinstance(claims, dict):
        raise JwtError("JWT payload is not an object.")
    return claims

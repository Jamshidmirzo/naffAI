"""
HackSoft: audit entries are written explicitly from services, not from signals.
Signals make traces opaque; explicit calls keep them grep-able.
"""

from __future__ import annotations

import re
from typing import Any

from django.contrib.auth import get_user_model

from .models import AuditAction, AuditLog

User = get_user_model()

# Any dict key matching this regex has its value replaced with "<redacted>"
# before we persist it to AuditLog.changes. Guards against a future service
# accidentally attaching a plaintext password / Fernet ciphertext / bot
# token / API key to an audit diff.
_SENSITIVE_KEY_RE = re.compile(
    r"(password|secret|session|token|api_key|access_key|qr|hmac)",
    re.IGNORECASE,
)
_REDACTED = "<redacted>"


def _scrub(value: Any) -> Any:
    """
    Recursively walk a JSON-ish structure and redact values whose *key*
    matches the sensitive-key regex. Handles dicts, lists, tuples; leaves
    scalars alone. Non-dict container keys (list indices) are never
    treated as sensitive — only dict keys.
    """
    if isinstance(value, dict):
        scrubbed: dict[Any, Any] = {}
        for k, v in value.items():
            if isinstance(k, str) and _SENSITIVE_KEY_RE.search(k):
                scrubbed[k] = _REDACTED
            else:
                scrubbed[k] = _scrub(v)
        return scrubbed
    if isinstance(value, list):
        return [_scrub(v) for v in value]
    if isinstance(value, tuple):
        return tuple(_scrub(v) for v in value)
    return value


def audit_log_create(
    *,
    user: Any | None,
    action: str,
    entity: str,
    entity_id: int | str,
    changes: dict | None = None,
    comment: str = "",
) -> AuditLog:
    return AuditLog.objects.create(
        user=user if user and getattr(user, "is_authenticated", False) else None,
        action=action,
        entity=entity,
        entity_id=str(entity_id),
        changes=_scrub(changes or {}),
        comment=comment,
    )


def audit_diff(old: dict, new: dict) -> dict:
    """Tiny field-level diff used by sales/operators when updating."""
    diff: dict[str, dict[str, Any]] = {}
    for key in set(old) | set(new):
        if old.get(key) != new.get(key):
            diff[key] = {"old": old.get(key), "new": new.get(key)}
    return diff


__all__ = ["AuditAction", "audit_diff", "audit_log_create"]


# Exposed for unit tests only.
_scrub_for_tests = _scrub

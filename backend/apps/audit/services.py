"""
HackSoft: audit entries are written explicitly from services, not from signals.
Signals make traces opaque; explicit calls keep them grep-able.
"""

from __future__ import annotations

from typing import Any

from django.contrib.auth import get_user_model

from .models import AuditAction, AuditLog

User = get_user_model()


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
        changes=changes or {},
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

"""Write-side operations for the notifications domain."""

from __future__ import annotations

import json
import logging
from typing import Iterable

from django.conf import settings
from django.contrib.auth import get_user_model
from django.db import transaction
from django.utils import timezone

from .models import Notification, NotificationKind

logger = logging.getLogger(__name__)
User = get_user_model()


# ---------------------------------------------------------------------------
# Redis pub/sub for SSE fan-out.
# ---------------------------------------------------------------------------

def _redis_client():
    """Lazy raw redis client — matches pattern in apps.common.health."""
    url = getattr(settings, "REDIS_URL", "") or ""
    if not url:
        return None
    try:
        import redis  # type: ignore[import-not-found]
    except Exception:
        return None
    try:
        return redis.Redis.from_url(
            url, socket_connect_timeout=3, socket_timeout=3
        )
    except Exception as exc:  # pragma: no cover
        logger.warning("notifications: redis client build failed: %s", exc)
        return None


def notif_channel(user_id: int) -> str:
    return f"notif:user:{int(user_id)}"


def _publish_sse_event(user_id: int, payload: dict) -> None:
    """Best-effort redis publish. Any error is logged, never raised —
    an SSE outage must never abort the originating transaction."""
    client = _redis_client()
    if client is None:
        return
    try:
        client.publish(notif_channel(user_id), json.dumps(payload, default=str))
    except Exception as exc:
        logger.warning("notifications: redis publish failed uid=%s: %s", user_id, exc)


def _schedule_sse_fanout(payloads_by_user: dict[int, dict]) -> None:
    """Register an on_commit hook that publishes to redis AFTER the current
    transaction commits — guarantees SSE listener reads an ORM row that
    actually exists."""
    def _emit():
        for uid, payload in payloads_by_user.items():
            _publish_sse_event(uid, payload)

    transaction.on_commit(_emit)


# ---------------------------------------------------------------------------
# Write-side services.
# ---------------------------------------------------------------------------


@transaction.atomic
def notification_broadcast(
    *,
    kind: str,
    title: str,
    body: str = "",
    link: str = "",
    recipient_ids: Iterable[int],
    metadata: dict | None = None,
) -> int:
    """
    Bulk-create one Notification row per recipient. Returns the count of
    rows created. Skips silently if `recipient_ids` is empty — no-op is a
    valid outcome (e.g. sale created but no seniors configured).

    Also schedules an on_commit redis publish to `notif:user:<id>` for the
    SSE listener. Fails open — SSE is best-effort.
    """
    ids = [i for i in recipient_ids if i]
    if not ids:
        return 0
    meta = metadata or {}
    rows = [
        Notification(
            recipient_id=uid,
            kind=kind,
            title=title[:280],
            body=body,
            link=link[:512],
            metadata=meta,
        )
        for uid in ids
    ]
    Notification.objects.bulk_create(rows, batch_size=200)

    # SSE fan-out — same payload shape as NotificationSerializer output.
    now_iso = timezone.now().isoformat()
    base_payload = {
        "kind": kind,
        "title": title[:280],
        "body": body,
        "link": link[:512],
        "metadata": meta,
        "created_at": now_iso,
    }
    _schedule_sse_fanout({uid: dict(base_payload) for uid in ids})
    return len(rows)


@transaction.atomic
def notification_mark_read(*, user_id: int, notification_ids: list[int]) -> int:
    return (
        Notification.objects.filter(recipient_id=user_id, id__in=notification_ids)
        .filter(read_at__isnull=True)
        .update(read_at=timezone.now())
    )


@transaction.atomic
def notification_mark_all_read(*, user_id: int) -> int:
    return Notification.objects.filter(
        recipient_id=user_id, read_at__isnull=True
    ).update(read_at=timezone.now())


__all__ = [
    "NotificationKind",
    "notification_broadcast",
    "notification_mark_read",
    "notification_mark_all_read",
    "notif_channel",
]

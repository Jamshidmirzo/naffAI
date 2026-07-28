"""Write-side operations for the notifications domain."""

from __future__ import annotations

from typing import Iterable

from django.contrib.auth import get_user_model
from django.db import transaction
from django.utils import timezone

from .models import Notification, NotificationKind

User = get_user_model()


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
    """
    ids = [i for i in recipient_ids if i]
    if not ids:
        return 0
    rows = [
        Notification(
            recipient_id=uid,
            kind=kind,
            title=title[:280],
            body=body,
            link=link[:512],
            metadata=metadata or {},
        )
        for uid in ids
    ]
    Notification.objects.bulk_create(rows, batch_size=200)
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
]

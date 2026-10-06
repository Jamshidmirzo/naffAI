"""Read-side queries for notifications."""

from django.db.models import Q, QuerySet

from .models import Notification


def notifications_for_user(
    *,
    user_id: int,
    only_unread: bool = False,
    kind: str | None = None,
) -> QuerySet[Notification]:
    qs = Notification.objects.filter(recipient_id=user_id)
    if only_unread:
        qs = qs.filter(read_at__isnull=True)
    if kind:
        qs = qs.filter(kind=kind)
    return qs


def unread_count_for_user(*, user_id: int) -> int:
    return (
        Notification.objects.filter(recipient_id=user_id, read_at__isnull=True)
        .count()
    )

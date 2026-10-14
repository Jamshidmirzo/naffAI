"""Read-side queries for notifications."""

from django.db.models import Q, QuerySet

from .models import Notification, NotificationKind, NotificationPreference


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


# ---------------------------------------------------------------------------
# 2026-10-14 design-atlas V2: per-user notification preferences.
# ---------------------------------------------------------------------------

# Какие kind'ы применимы к какой роли (по фактическим продюсерам):
#   senior (team_lead/manager/super_manager/superadmin) — sale_created,
#     sale_returned, birthday, system;
#   operator — lead_assigned, callback_overdue, sale_rejected,
#     sale_celebration, system.
# `snapshot_request` — служебная команда «сделай снимок» (фронт оператора
# реагирует на неё автоматически), поэтому НЕ настраивается и никогда не
# фильтруется в broadcast.
SENIOR_PREFERENCE_KINDS: tuple[str, ...] = (
    NotificationKind.SALE_CREATED,
    NotificationKind.SALE_RETURNED,
    NotificationKind.BIRTHDAY,
    NotificationKind.SYSTEM,
)
OPERATOR_PREFERENCE_KINDS: tuple[str, ...] = (
    NotificationKind.LEAD_ASSIGNED,
    NotificationKind.CALLBACK_OVERDUE,
    NotificationKind.SALE_REJECTED,
    NotificationKind.SALE_CELEBRATION,
    NotificationKind.SYSTEM,
)
CONFIGURABLE_KINDS: frozenset[str] = frozenset(
    str(k) for k in (*SENIOR_PREFERENCE_KINDS, *OPERATOR_PREFERENCE_KINDS)
)

PREFERENCE_DEFAULTS = {"in_app": True, "telegram": False}


def notification_kinds_for_user(user) -> list[str]:
    """Kind'ы, которые имеют смысл для роли пользователя (порядок стабилен)."""
    from apps.users.models import Role
    from apps.users.permissions import SENIOR_ROLES, _role

    role = _role(user)
    if user is not None and getattr(user, "is_superuser", False):
        role = Role.SUPERADMIN
    if role in SENIOR_ROLES:
        return [str(k) for k in SENIOR_PREFERENCE_KINDS]
    if role == Role.OPERATOR:
        return [str(k) for k in OPERATOR_PREFERENCE_KINDS]
    return []


def notification_preferences_for_user(user) -> list[dict]:
    """
    `[{"kind", "in_app", "telegram"}, ...]` по всем применимым kind'ам —
    недостающие строки достраиваются defaults'ами.
    """
    kinds = notification_kinds_for_user(user)
    stored = {
        p.kind: p
        for p in NotificationPreference.objects.filter(user_id=user.id, kind__in=kinds)
    }
    items: list[dict] = []
    for kind in kinds:
        p = stored.get(kind)
        items.append(
            {
                "kind": kind,
                "in_app": p.in_app if p else PREFERENCE_DEFAULTS["in_app"],
                "telegram": p.telegram if p else PREFERENCE_DEFAULTS["telegram"],
            }
        )
    return items


def notification_in_app_muted_user_ids(*, kind: str, user_ids) -> set[int]:
    """Подмножество `user_ids`, у которых `in_app=False` для этого kind."""
    if str(kind) not in CONFIGURABLE_KINDS:
        return set()
    ids = [int(i) for i in user_ids if i]
    if not ids:
        return set()
    return set(
        NotificationPreference.objects.filter(
            user_id__in=ids, kind=kind, in_app=False
        ).values_list("user_id", flat=True)
    )

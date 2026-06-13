from __future__ import annotations

from django.db import transaction

from apps.audit.services import AuditAction, audit_log_create
from apps.common.exceptions import ApplicationError

from .models import Channel


@transaction.atomic
def channel_create(*, name: str, is_active: bool = True, user=None) -> Channel:
    name = (name or "").strip()
    if not name:
        raise ApplicationError("Название не может быть пустым", {"field": "name"})
    existing = Channel.objects.filter(name__iexact=name).first()
    if existing:
        # Reactivate a previously-deactivated partner instead of erroring out.
        if not existing.is_active and is_active:
            existing.is_active = True
            existing.save(update_fields=["is_active", "updated_at"])
            audit_log_create(
                user=user,
                action=AuditAction.UPDATE,
                entity="catalog.Channel",
                entity_id=existing.id,
                changes={"is_active": True},
                comment="reactivated via create",
            )
            return existing
        raise ApplicationError(
            f"Партнёр «{existing.name}» уже существует",
            {"field": "name", "existing_id": existing.id},
        )
    channel = Channel.objects.create(name=name, is_active=is_active)
    audit_log_create(
        user=user,
        action=AuditAction.CREATE,
        entity="catalog.Channel",
        entity_id=channel.id,
        changes={"name": channel.name, "is_active": channel.is_active},
    )
    return channel


@transaction.atomic
def channel_update(*, channel: Channel, user=None, **fields) -> Channel:
    old = {"name": channel.name, "is_active": channel.is_active}
    for k, v in fields.items():
        setattr(channel, k, v)
    channel.save()
    audit_log_create(
        user=user,
        action=AuditAction.UPDATE,
        entity="catalog.Channel",
        entity_id=channel.id,
        changes={"before": old, "after": fields},
    )
    return channel

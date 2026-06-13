from __future__ import annotations

from django.db import transaction

from apps.audit.services import AuditAction, audit_log_create

from .models import Channel


@transaction.atomic
def channel_create(*, name: str, is_active: bool = True, user=None) -> Channel:
    channel = Channel.objects.create(name=name.strip(), is_active=is_active)
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

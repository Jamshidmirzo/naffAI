"""
Write-side для системных настроек. Все изменения проходят через
`system_setting_update`, чтобы audit-log писался в одном месте.
"""

from __future__ import annotations

from typing import Any

from django.db import transaction

from apps.audit.services import AuditAction, audit_log_create

from .models import SystemSetting


@transaction.atomic
def system_setting_update(
    *,
    user: Any | None = None,
    auto_distribution_enabled: bool | None = None,
) -> SystemSetting:
    obj = SystemSetting.get_solo()

    changes: dict[str, dict[str, Any]] = {}
    dirty_fields: list[str] = []

    if (
        auto_distribution_enabled is not None
        and obj.auto_distribution_enabled != auto_distribution_enabled
    ):
        changes["auto_distribution_enabled"] = {
            "from": obj.auto_distribution_enabled,
            "to": auto_distribution_enabled,
        }
        obj.auto_distribution_enabled = auto_distribution_enabled
        dirty_fields.append("auto_distribution_enabled")

    if not dirty_fields:
        return obj

    obj.updated_by = user if user and getattr(user, "is_authenticated", False) else None
    dirty_fields.append("updated_by")
    dirty_fields.append("updated_at")
    obj.save(update_fields=dirty_fields)

    audit_log_create(
        user=user,
        action=AuditAction.UPDATE,
        entity="system_settings.SystemSetting",
        entity_id=obj.pk,
        changes=changes,
        comment="Изменение системных настроек",
    )
    return obj

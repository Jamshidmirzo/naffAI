"""
Write-side для системных настроек. Все изменения проходят через
`system_setting_update`, чтобы audit-log писался в одном месте.
"""

from __future__ import annotations

from typing import Any

from django.core.exceptions import ValidationError
from django.db import transaction

from apps.audit.services import AuditAction, audit_log_create

from .models import SystemSetting


@transaction.atomic
def system_setting_update(
    *,
    user: Any | None = None,
    auto_distribution_enabled: bool | None = None,
    morning_gate_enabled: bool | None = None,
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

    if morning_gate_enabled is not None and obj.morning_gate_enabled != morning_gate_enabled:
        changes["morning_gate_enabled"] = {
            "from": obj.morning_gate_enabled,
            "to": morning_gate_enabled,
        }
        obj.morning_gate_enabled = morning_gate_enabled
        dirty_fields.append("morning_gate_enabled")

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


@transaction.atomic
def retry_export_statuses_update(
    *,
    user: Any | None = None,
    statuses: list[str],
) -> SystemSetting:
    """
    Заменяет `SystemSetting.retry_export_statuses` (write через сервис —
    audit-log в одной точке).

    Валидация:
      - список строк (не dict/int/None);
      - каждый code должен существовать в LeadStatusLabel (иначе Sheets
        export упадёт молча при следующей выгрузке).

    Пустой список разрешён — селектор `get_retry_export_statuses`
    воспримет его как «использовать дефолт».
    """
    if not isinstance(statuses, list):
        raise ValidationError("statuses должен быть списком")

    # Локальный import, чтобы избежать circular deps (system_settings ↔ leads).
    from apps.leads.models import LeadStatusLabel

    normalised: list[str] = []
    for code in statuses:
        if not isinstance(code, str):
            raise ValidationError(f"Некорректный тип code: {type(code).__name__}")
        code = code.strip()
        if not code:
            continue
        normalised.append(code)

    if normalised:
        existing = set(
            LeadStatusLabel.objects.filter(code__in=normalised).values_list(
                "code", flat=True
            )
        )
        missing = [c for c in normalised if c not in existing]
        if missing:
            raise ValidationError(
                f"Неизвестные code'ы LeadStatusLabel: {', '.join(missing)}"
            )

    obj = SystemSetting.get_solo()
    old_value = list(obj.retry_export_statuses or [])
    if old_value == normalised:
        return obj

    obj.retry_export_statuses = normalised
    obj.updated_by = user if user and getattr(user, "is_authenticated", False) else None
    obj.save(update_fields=["retry_export_statuses", "updated_by", "updated_at"])

    audit_log_create(
        user=user,
        action=AuditAction.UPDATE,
        entity="system_settings.SystemSetting",
        entity_id=obj.pk,
        changes={
            "retry_export_statuses": {"from": old_value, "to": normalised},
        },
        comment="Обновление retry-export статусов",
    )
    return obj

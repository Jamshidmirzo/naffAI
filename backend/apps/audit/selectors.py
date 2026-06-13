from __future__ import annotations

from django.db.models import QuerySet

from .models import AuditLog


def audit_log_list(
    *, entity: str | None = None, entity_id: str | None = None
) -> QuerySet[AuditLog]:
    qs = AuditLog.objects.select_related("user").order_by("-created_at")
    if entity:
        qs = qs.filter(entity=entity)
    if entity_id:
        qs = qs.filter(entity_id=entity_id)
    return qs

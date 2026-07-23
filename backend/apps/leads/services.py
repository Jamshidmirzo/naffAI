"""
Write-side operations for leads.

Every function that mutates state:
  - runs inside `@transaction.atomic`
  - resolves inputs into concrete DB rows before writing
  - writes an `AuditLog` entry with a JSON diff / snapshot

The audit call goes through `apps.audit.services.audit_log_create` so all
lifecycle events (sheet import, auto-assignment, manual reassignment, TG
link cache updates, sale conversion) end up on the same searchable timeline
as sales edits.
"""

from __future__ import annotations

import datetime as dt
from typing import Any

from django.db import transaction
from django.utils import timezone

from apps.audit.services import AuditAction, audit_log_create
from apps.common.exceptions import ApplicationError
from apps.common.validators import normalize_uz_phone
from apps.operators.models import Operator, OperatorStatus

from .models import (
    Lead,
    LeadAssignment,
    LeadAssignmentSource,
    LeadSource,
    LeadStatus,
    OperatorSheetAlias,
    SheetSource,
    TelegramLink,
)
from .selectors import alias_lookup, next_operator_for_round_robin

# ---- helpers -------------------------------------------------------------


def _extract_metadata(raw_row: dict, column_map: dict) -> dict:
    """
    Copies the columns listed under `column_map["extra"]` (a list of header
    names) verbatim to the lead's metadata jsonb. Missing columns are
    quietly skipped — the mapper is best-effort and can outlive schema
    tweaks upstream.
    """
    extra_keys = column_map.get("extra") or []
    if not isinstance(extra_keys, list):
        return {}
    return {k: raw_row.get(k) for k in extra_keys if k in raw_row}


def _pick_column(raw_row: dict, spec: Any) -> str:
    """
    `spec` is either:
      - a string header name → `raw_row[spec]`
      - a dict `{"column_index": N}` → positional lookup by 1-based index
        (used when the sheet column has no header)
      - None / missing → empty string

    Positional lookups require the sync layer to also pass the row cells
    in order under the reserved `"__cells__"` key of `raw_row`.
    """
    if spec is None:
        return ""
    if isinstance(spec, str):
        val = raw_row.get(spec)
        return "" if val is None else str(val).strip()
    if isinstance(spec, dict) and "column_index" in spec:
        cells = raw_row.get("__cells__") or []
        idx = int(spec["column_index"]) - 1
        if 0 <= idx < len(cells):
            v = cells[idx]
            return "" if v is None else str(v).strip()
    return ""


# ---- lead lifecycle ------------------------------------------------------


@transaction.atomic
def lead_create(
    *,
    user=None,
    full_name: str = "",
    phone: str = "",
    product_hint: str = "",
    has_card: str = "",
    source: str = LeadSource.MANUAL,
    metadata: dict | None = None,
    auto_assign: bool = True,
    status: str | None = None,
) -> Lead:
    """
    Manual / API-driven lead creation. Phone is normalized inside; if it
    fails the lead is still created but flagged `phone_invalid=True` and
    routed to `needs_review`.
    """
    normalized, valid = normalize_uz_phone(phone)
    lead = Lead.objects.create(
        full_name=(full_name or "").strip()[:128],
        phone_raw=(phone or "").strip()[:64],
        phone=normalized if valid else "",
        phone_invalid=not valid,
        product_hint=(product_hint or "").strip()[:256],
        has_card=(has_card or "").strip()[:64],
        source=source,
        metadata=metadata or {},
        needs_review=not valid,
        status=(
            status
            if status
            else (LeadStatus.NEEDS_REVIEW if not valid else LeadStatus.NEW)
        ),
        created_by=user if user and getattr(user, "is_authenticated", False) else None,
    )
    audit_log_create(
        user=user,
        action=AuditAction.CREATE,
        entity="leads.Lead",
        entity_id=lead.id,
        changes={
            "full_name": lead.full_name,
            "phone": lead.phone,
            "phone_invalid": lead.phone_invalid,
            "source": lead.source,
            "status": lead.status,
        },
    )
    if auto_assign and not lead.phone_invalid and lead.status == LeadStatus.NEW:
        try:
            lead_auto_assign(lead=lead, user=user)
        except ApplicationError:
            # No eligible operator right now — leave the lead unassigned.
            pass
    return lead


@transaction.atomic
def lead_create_from_sheet_row(
    *,
    sheet_source: SheetSource,
    row_index: int,
    raw_row: dict,
) -> Lead | None:
    """
    Idempotent by `(sheet_source, row_index)`. If a lead for that pair already
    exists we return it untouched — sync loops don't overwrite manual edits.

    Column resolution goes through `_pick_column`, which supports both
    header-name and positional (`{"column_index": N}`) specs so the same
    codepath handles Sheet 1 (has headers) and the operator column of Sheet
    2 (no header on the column that carries the operator alias).
    """
    existing = Lead.objects.filter(
        sheet_source=sheet_source, sheet_row_index=row_index
    ).first()
    if existing:
        return existing

    cm = sheet_source.column_map or {}
    full_name = _pick_column(raw_row, cm.get("full_name"))
    phone_raw = _pick_column(raw_row, cm.get("phone"))
    product_hint = _pick_column(raw_row, cm.get("product_hint"))
    has_card = _pick_column(raw_row, cm.get("has_card"))
    operator_alias = _pick_column(raw_row, cm.get("operator_alias"))

    normalized, valid = normalize_uz_phone(phone_raw)
    metadata = _extract_metadata(raw_row, cm)

    default_status = sheet_source.default_status or LeadStatus.NEW
    needs_review = False
    status = default_status

    # Resolve operator from alias (per spec):
    #   - alias empty            → status stays default, will hit round-robin below
    #   - alias known + bound    → create sheet_manual assignment right away
    #   - alias known + unbound  → mark needs_review
    #   - alias unknown          → mark needs_review AND persist the alias
    #                              with operator=None so admin can bind it later
    assigned_op: Operator | None = None
    assignment_reason = ""
    if operator_alias:
        alias = alias_lookup(operator_alias)
        if alias is None:
            OperatorSheetAlias.objects.get_or_create(alias_name=operator_alias.strip())
            needs_review = True
            status = LeadStatus.NEEDS_REVIEW
            assignment_reason = f"Неизвестный alias «{operator_alias}»"
        elif alias.operator is None:
            needs_review = True
            status = LeadStatus.NEEDS_REVIEW
            assignment_reason = f"Alias «{operator_alias}» не привязан к оператору"
        else:
            assigned_op = alias.operator

    if not valid:
        needs_review = True
        status = LeadStatus.NEEDS_REVIEW

    if default_status == LeadStatus.ARCHIVED:
        # Archived rows (sheet 3 Bitrix export): skip auto-assignment and the
        # needs_review escalations — we're only importing them for history.
        needs_review = False
        status = LeadStatus.ARCHIVED
        assigned_op = None

    lead = Lead.objects.create(
        full_name=full_name[:128],
        phone_raw=phone_raw[:64],
        phone=normalized if valid else "",
        phone_invalid=not valid,
        product_hint=product_hint[:256],
        has_card=has_card[:64],
        status=status,
        source=LeadSource.SHEET,
        sheet_source=sheet_source,
        sheet_row_index=row_index,
        operator=assigned_op,
        needs_review=needs_review,
        metadata=metadata,
    )
    audit_log_create(
        user=None,
        action=AuditAction.CREATE,
        entity="leads.Lead",
        entity_id=lead.id,
        changes={
            "sheet_gid": sheet_source.gid,
            "sheet_row_index": row_index,
            "full_name": full_name,
            "phone": normalized,
            "phone_invalid": not valid,
            "operator_alias": operator_alias,
            "needs_review": needs_review,
            "status": status,
        },
        comment="Импорт из Google Sheets",
    )
    if assigned_op is not None:
        # We got a real operator from the alias, but a broken phone still
        # trumps assignment — the team lead has to review before this lead
        # goes into the call rotation.
        LeadAssignment.objects.create(
            lead=lead,
            operator=assigned_op,
            source=LeadAssignmentSource.SHEET_MANUAL,
            reason=f"alias «{operator_alias}»",
        )
        if not needs_review:
            lead.status = LeadStatus.ASSIGNED
            lead.save(update_fields=["status", "updated_at"])
    elif not needs_review and status == LeadStatus.NEW and valid:
        # No alias in the row, still valid → hand to auto-assignment.
        try:
            lead_auto_assign(lead=lead, user=None)
        except ApplicationError:
            pass  # no eligible op right now → leave in `new`
    elif needs_review and assignment_reason:
        audit_log_create(
            user=None,
            action=AuditAction.UPDATE,
            entity="leads.Lead",
            entity_id=lead.id,
            changes={"needs_review_reason": assignment_reason},
        )
    return lead


@transaction.atomic
def lead_auto_assign(*, lead: Lead, user=None) -> LeadAssignment:
    """
    Pick an eligible operator via round-robin and assign the lead to them.
    Fails loudly (`ApplicationError`) if nobody is eligible — callers can
    choose to swallow this and leave the lead unassigned.
    """
    op = next_operator_for_round_robin()
    if op is None:
        raise ApplicationError(
            "Нет доступных операторов для авто-распределения",
            {"reason": "no_eligible_operator"},
        )
    LeadAssignment.objects.filter(lead=lead, active=True).update(active=False)
    assignment = LeadAssignment.objects.create(
        lead=lead,
        operator=op,
        source=LeadAssignmentSource.AUTO_ROUND_ROBIN,
    )
    lead.operator = op
    if lead.status == LeadStatus.NEW:
        lead.status = LeadStatus.ASSIGNED
    lead.save(update_fields=["operator", "status", "updated_at"])
    audit_log_create(
        user=user,
        action=AuditAction.UPDATE,
        entity="leads.Lead",
        entity_id=lead.id,
        changes={
            "assignment": {
                "operator_id": op.id,
                "operator_name": op.full_name,
                "source": LeadAssignmentSource.AUTO_ROUND_ROBIN,
            }
        },
        comment="Авто-распределение",
    )
    return assignment


@transaction.atomic
def lead_reassign(
    *, lead: Lead, new_operator: Operator, user=None, reason: str = ""
) -> LeadAssignment:
    if new_operator.status != OperatorStatus.ACTIVE:
        raise ApplicationError(
            "Нельзя назначить лид неактивному оператору",
            {"field": "operator", "operator_status": new_operator.status},
        )
    old_op = lead.operator
    LeadAssignment.objects.filter(lead=lead, active=True).update(active=False)
    assignment = LeadAssignment.objects.create(
        lead=lead,
        operator=new_operator,
        source=LeadAssignmentSource.ADMIN_REASSIGN,
        reason=reason[:256],
    )
    lead.operator = new_operator
    lead.needs_review = False
    if lead.status in (LeadStatus.NEW, LeadStatus.NEEDS_REVIEW):
        lead.status = LeadStatus.ASSIGNED
    lead.save(update_fields=["operator", "needs_review", "status", "updated_at"])
    audit_log_create(
        user=user,
        action=AuditAction.UPDATE,
        entity="leads.Lead",
        entity_id=lead.id,
        changes={
            "assignment": {
                "old_operator_id": old_op.id if old_op else None,
                "new_operator_id": new_operator.id,
                "source": LeadAssignmentSource.ADMIN_REASSIGN,
                "reason": reason,
            }
        },
        comment=reason or "Ручное переназначение",
    )
    return assignment


@transaction.atomic
def lead_update_status(*, lead: Lead, status: str, user=None, comment: str = "") -> Lead:
    if status not in dict(LeadStatus.choices):
        raise ApplicationError("Неизвестный статус лида", {"field": "status"})
    old = lead.status
    if old == status:
        return lead
    lead.status = status
    lead.save(update_fields=["status", "updated_at"])
    audit_log_create(
        user=user,
        action=AuditAction.UPDATE,
        entity="leads.Lead",
        entity_id=lead.id,
        changes={"status": {"old": old, "new": status}},
        comment=comment,
    )
    return lead


@transaction.atomic
def lead_convert_to_sale(*, lead: Lead, user=None, sale_data: dict):
    """
    Turn a lead into a real `Sale`:
      1. Delegate to `sale_create` (all sales business rules stay there).
      2. Link the resulting Sale back to the lead.
      3. Mark the lead `won`.

    The sale_data payload accepts the same keys as
    `apps.sales.services.sale_create` — the caller is responsible for
    building it (usually from a serializer). If `operators`/`operator_id`
    are omitted we default to the lead's currently-assigned operator.
    """
    # Local import to avoid app-loading cycles.
    from apps.sales.services import sale_create

    if not sale_data.get("operators") and not sale_data.get("operator_id"):
        if lead.operator_id is None:
            raise ApplicationError(
                "У лида нет оператора — назначьте его перед конвертацией",
                {"field": "operator"},
            )
        sale_data = {**sale_data, "operator_id": lead.operator_id}

    sale = sale_create(user=user, **sale_data)
    sale.lead = lead
    sale.save(update_fields=["lead", "updated_at"])

    lead.status = LeadStatus.WON
    lead.save(update_fields=["status", "updated_at"])
    audit_log_create(
        user=user,
        action=AuditAction.UPDATE,
        entity="leads.Lead",
        entity_id=lead.id,
        changes={"status": {"old": LeadStatus.IN_PROGRESS, "new": LeadStatus.WON}, "sale_id": sale.id},
        comment="Конвертация в продажу",
    )
    return sale


# ---- Telegram link cache -------------------------------------------------


@transaction.atomic
def telegram_link_upsert(*, phone: str, username: str = "") -> TelegramLink | None:
    """
    Idempotent upsert of the phone↔username cache. Returns None if the
    phone can't be normalized (nothing to cache against).
    """
    normalized, valid = normalize_uz_phone(phone)
    if not valid:
        return None
    link, _ = TelegramLink.objects.update_or_create(
        phone=normalized,
        defaults={
            "username": (username or "").lstrip("@").strip()[:64],
            "verified_at": timezone.now() if username else None,
        },
    )
    return link


# ---- Sheet configuration -------------------------------------------------


@transaction.atomic
def sheet_source_upsert(
    *,
    name: str,
    spreadsheet_id: str,
    gid: int,
    column_map: dict,
    default_status: str = LeadStatus.NEW,
    worksheet_name: str = "",
    active: bool = True,
    user=None,
) -> SheetSource:
    obj, created = SheetSource.objects.update_or_create(
        spreadsheet_id=spreadsheet_id,
        gid=gid,
        defaults={
            "name": name[:128],
            "worksheet_name": worksheet_name[:128],
            "column_map": column_map,
            "default_status": default_status,
            "active": active,
        },
    )
    audit_log_create(
        user=user,
        action=AuditAction.CREATE if created else AuditAction.UPDATE,
        entity="leads.SheetSource",
        entity_id=obj.id,
        changes={
            "name": obj.name,
            "spreadsheet_id": obj.spreadsheet_id,
            "gid": obj.gid,
            "active": obj.active,
        },
    )
    return obj


@transaction.atomic
def operator_alias_upsert(
    *, alias_name: str, operator: Operator | None, user=None
) -> OperatorSheetAlias:
    if not alias_name.strip():
        raise ApplicationError("Alias не может быть пустым", {"field": "alias_name"})
    obj, created = OperatorSheetAlias.objects.update_or_create(
        alias_name=alias_name.strip()[:128],
        defaults={"operator": operator},
    )
    audit_log_create(
        user=user,
        action=AuditAction.CREATE if created else AuditAction.UPDATE,
        entity="leads.OperatorSheetAlias",
        entity_id=obj.id,
        changes={
            "alias_name": obj.alias_name,
            "operator_id": operator.id if operator else None,
        },
    )
    return obj


@transaction.atomic
def sheet_source_bump_watermark(
    *, sheet_source: SheetSource, last_row: int, synced_at: dt.datetime | None = None
) -> None:
    """Small utility so the sync command doesn't touch model rows directly."""
    if last_row <= sheet_source.last_synced_row:
        return
    sheet_source.last_synced_row = last_row
    sheet_source.last_synced_at = synced_at or timezone.now()
    sheet_source.save(update_fields=["last_synced_row", "last_synced_at", "updated_at"])

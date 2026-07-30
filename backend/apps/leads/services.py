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
import logging
import threading
from typing import Any

from django.db import transaction
from django.utils import timezone

logger = logging.getLogger("leads.writeback")

from apps.audit.services import AuditAction, audit_log_create
from apps.common.exceptions import ApplicationError
from apps.common.validators import normalize_uz_phone
from apps.operators.models import Operator, OperatorStatus

from .models import (
    DistributionMode,
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


# Map the free-form Uzbek/Russian status strings that operators type
# directly into the source sheet to our canonical LeadStatus. Keys are
# compared case-insensitively and stripped of whitespace/punctuation.
_SHEET_STATUS_MAP: dict[str, str] = {
    "javob bermadi 1": LeadStatus.NO_ANSWER,
    "javob bermadi": LeadStatus.NO_ANSWER,
    "не ответил": LeadStatus.NO_ANSWER,
    "не берет": LeadStatus.NO_ANSWER,
    "не берёт": LeadStatus.NO_ANSWER,
    "javob bermadi 2": LeadStatus.NO_ANSWER_2,
    "не ответил 2": LeadStatus.NO_ANSWER_2,
    "telfoni ochiq": LeadStatus.PHONE_ON,
    "telefoni ochiq": LeadStatus.PHONE_ON,
    "телефон включен": LeadStatus.PHONE_ON,
    "телефон включён": LeadStatus.PHONE_ON,
    "tgga boglandi": LeadStatus.CONTACTED_TELEGRAM,
    "tg ga boglandi": LeadStatus.CONTACTED_TELEGRAM,
    "tg da yozdi": LeadStatus.CONTACTED_TELEGRAM,
    "tg": LeadStatus.CONTACTED_TELEGRAM,
    "телеграм": LeadStatus.CONTACTED_TELEGRAM,
    "qarzi bor": LeadStatus.HAS_DEBT,
    "долг": LeadStatus.HAS_DEBT,
    "у клиента долг": LeadStatus.HAS_DEBT,
    "callback": LeadStatus.CALLBACK_SCHEDULED,
    "перезвонить": LeadStatus.CALLBACK_SCHEDULED,
    "sotildi": LeadStatus.WON,
    "продажа": LeadStatus.WON,
    "sotilmadi": LeadStatus.LOST,
    "отказ": LeadStatus.LOST,
    "потерян": LeadStatus.LOST,
}


def _map_sheet_status(raw: str) -> str | None:
    """
    Normalise and look up the free-form sheet status label. First checks the
    hard-coded synonym map (Uzbek/Russian slang → builtin codes), then falls
    back to a DB lookup on `LeadStatusLabel.label_ru / label_uz` so that
    custom manager-created statuses ("Ждёт зарплаты") work too.
    """
    if not raw:
        return None
    key = raw.strip().lower()
    if not key:
        return None
    mapped = _SHEET_STATUS_MAP.get(key)
    if mapped:
        return mapped
    from django.db.models import Q

    from .models import LeadStatusLabel

    row = (
        LeadStatusLabel.objects.filter(is_active=True)
        .filter(Q(label_ru__iexact=key) | Q(label_uz__iexact=key))
        .values_list("code", flat=True)
        .first()
    )
    return row


def _scan_row_for_phones(cells: list[Any]) -> tuple[list[str], int]:
    """
    Scan the row for every valid +998 number. Returns
    (distinct_normalized_list, 1-based-col-of-first-hit-from-the-right).

    The list preserves the right→left order — the fully-normalized
    `+998...` cell (usually rightmost) becomes the primary phone; the
    same-client alternative (usually left of it, e.g. an unnormalized
    duplicate OR a genuinely different second number) becomes phone_alt.
    Duplicates after normalization are collapsed.
    """
    found: list[str] = []
    first_col = -1
    for i in range(len(cells) - 1, -1, -1):
        raw = "" if cells[i] is None else str(cells[i]).strip()
        if not raw:
            continue
        norm, valid = normalize_uz_phone(raw)
        if not valid or norm in found:
            continue
        found.append(norm)
        if first_col < 0:
            first_col = i + 1
    return found, first_col


def _scan_row_for_phone(cells: list[Any]) -> tuple[str, int]:
    """
    Backward-compat single-phone wrapper — returns just the primary phone
    and its column. Callers who need both should use _scan_row_for_phones.
    """
    phones, col = _scan_row_for_phones(cells)
    return (phones[0] if phones else ""), col


def _scan_row_for_name(cells: list[Any], *, phone_col_1based: int) -> str:
    """
    Fallback name finder. Looks for the first alphabetic cell after col 1
    (which is the product hint in every srm-family sheet) and before the
    phone column. Skips cells that are just digits/dots/punctuation
    (age numbers, duplicated phones).
    """
    start = 1  # skip col 1 = product
    stop = phone_col_1based - 1 if phone_col_1based > 0 else len(cells)
    for i in range(start, min(stop, len(cells))):
        raw = "" if cells[i] is None else str(cells[i]).strip()
        if not raw:
            continue
        if any(ch.isalpha() for ch in raw):
            return raw
    return ""


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


# ---- Google-Sheet writeback ---------------------------------------------

# Default writeback layout: assumes source rows only fill A/B/C and D-G
# are free. Overridable per SheetSource.writeback_columns in the admin UI.
_WRITEBACK_DEFAULTS = {
    "enabled": True,
    "status_col": "D",
    "operator_col": "E",
    "updated_col": "F",
    "comment_col": "G",
}


def _writeback_config(sheet_source) -> dict:
    cfg = dict(_WRITEBACK_DEFAULTS)
    cfg.update(sheet_source.writeback_columns or {})
    return cfg


def _col_to_idx(letters: str) -> int:
    letters = letters.strip().upper()
    n = 0
    for ch in letters:
        n = n * 26 + (ord(ch) - ord("A") + 1)
    return n


def _idx_to_col(idx: int) -> str:
    out = ""
    while idx > 0:
        idx, r = divmod(idx - 1, 26)
        out = chr(ord("A") + r) + out
    return out


def _min_max_col(cols: list[str]) -> tuple[str, str]:
    """Given ["D", "E", "F", "G"] return ("D", "G")."""
    ordered = sorted(cols, key=_col_to_idx)
    return ordered[0], ordered[-1]


def _cols_between(lo: str, hi: str) -> list[str]:
    return [_idx_to_col(i) for i in range(_col_to_idx(lo), _col_to_idx(hi) + 1)]


def lead_writeback_to_sheet(lead, comment: str = "") -> None:
    """
    Push the lead's current state (status label, operator, timestamp,
    optional comment) into the source Google sheet row it came from.
    Fails silent-with-log — never let a writeback error break the caller.
    """
    sheet_source = lead.sheet_source
    if sheet_source is None or lead.sheet_row_index is None:
        return
    cfg = _writeback_config(sheet_source)
    if not cfg.get("enabled", True):
        return

    # Human-readable status label — prefer the manager-editable catalog,
    # fall back to the raw code.
    from .models import LeadStatusLabel

    label = LeadStatusLabel.objects.filter(code=lead.status).values_list(
        "label_ru", flat=True
    ).first() or lead.status

    operator_name = lead.operator.full_name if lead.operator_id else "—"
    updated = timezone.localtime(timezone.now()).strftime("%Y-%m-%d %H:%M")

    try:
        from .integrations.google_sheets.client import (
            GoogleSheetsClient,
            GoogleSheetsUnavailable,
        )
    except Exception as exc:  # pragma: no cover
        logger.warning("google-sheets client import failed: %s", exc)
        return

    try:
        client = GoogleSheetsClient()
    except GoogleSheetsUnavailable as exc:
        logger.warning("writeback disabled: %s", exc)
        return

    ws_name = sheet_source.worksheet_name or client.worksheet_name_by_gid(
        sheet_source.spreadsheet_id, sheet_source.gid
    )
    if not ws_name:
        logger.warning("writeback: cannot resolve worksheet name for gid=%s", sheet_source.gid)
        return

    safe = ws_name.replace("'", "''")
    row_index = lead.sheet_row_index

    # Auto-offset: pick the writeback start column once per lead so we
    # never overwrite real data on rows whose format shifted right
    # (srm added an "age" column, pushing phone into E). Result is
    # sticky — cached in metadata.writeback_start_col so subsequent
    # writebacks land in the same cells and don't drift rightward.
    metadata = lead.metadata or {}
    cached_start = metadata.get("writeback_start_col")
    default_start_idx = _col_to_idx(cfg["status_col"])
    if cached_start:
        chosen_start_idx = _col_to_idx(cached_start)
    else:
        try:
            row_cells = client.raw_values(
                sheet_source.spreadsheet_id,
                f"'{safe}'!A{row_index}:Z{row_index}",
            )
            cells = row_cells[0] if row_cells else []
        except Exception:
            cells = []
        last_data_col = 0
        for i, v in enumerate(cells, start=1):
            if v is not None and str(v).strip():
                last_data_col = i
        chosen_start_idx = max(default_start_idx, last_data_col + 1)
        # Persist so future writebacks stay in the same 4-cell block.
        metadata["writeback_start_col"] = _idx_to_col(chosen_start_idx)
        Lead.objects.filter(pk=lead.pk).update(metadata=metadata)

    shift = chosen_start_idx - default_start_idx
    status_col = _idx_to_col(_col_to_idx(cfg["status_col"]) + shift)
    operator_col = _idx_to_col(_col_to_idx(cfg["operator_col"]) + shift)
    updated_col = _idx_to_col(_col_to_idx(cfg["updated_col"]) + shift)
    comment_col = _idx_to_col(_col_to_idx(cfg["comment_col"]) + shift)

    # Sparse layout is fine — build one continuous range from min→max
    # column, filling non-target cells with `None` so we don't clobber
    # unrelated data (Google's RAW mode leaves nulls untouched).
    lo, hi = _min_max_col([status_col, operator_col, updated_col, comment_col])
    cell_map = {
        status_col: label,
        operator_col: operator_name,
        updated_col: updated,
        comment_col: (comment or "").strip(),
    }
    row_values = [cell_map.get(col, None) for col in _cols_between(lo, hi)]

    sheet_range = f"'{safe}'!{lo}{row_index}:{hi}{row_index}"

    try:
        client.update_cells(
            sheet_source.spreadsheet_id, sheet_range, [row_values]
        )
    except Exception:
        logger.exception(
            "writeback failed lead=%s range=%s", lead.id, sheet_range
        )


def _writeback_async(lead_id: int, comment: str = "") -> None:
    """
    Fire a daemon thread to write the lead's state back into the sheet.
    Callers should schedule this via `transaction.on_commit` so the DB
    change is durable before we try to reflect it in Google.
    """
    def _run() -> None:
        try:
            from .models import Lead

            lead = Lead.objects.select_related("sheet_source", "operator").get(pk=lead_id)
            lead_writeback_to_sheet(lead, comment=comment)
        except Exception:
            logger.exception("_writeback_async: fetch/write failed for lead=%s", lead_id)

    threading.Thread(target=_run, daemon=True).start()


def _schedule_writeback(lead_id: int, comment: str = "") -> None:
    """Wire the writeback to fire once the surrounding transaction commits."""
    transaction.on_commit(lambda: _writeback_async(lead_id, comment))


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
    cm = sheet_source.column_map or {}
    sheet_status_raw = _pick_column(raw_row, cm.get("status"))
    mapped_sheet_status = _map_sheet_status(sheet_status_raw)

    existing = Lead.objects.filter(
        sheet_source=sheet_source, sheet_row_index=row_index
    ).first()
    if existing:
        # Re-sync should honour freshly-typed status changes from the
        # sheet — the operator may have marked "javob bermadi 2" after
        # our first import.
        if mapped_sheet_status and existing.status != mapped_sheet_status:
            lead_update_status(
                lead=existing,
                status=mapped_sheet_status,
                comment=f"resync: sheet status «{sheet_status_raw}»",
            )
        return existing

    full_name = _pick_column(raw_row, cm.get("full_name"))
    phone_raw = _pick_column(raw_row, cm.get("phone"))
    product_hint = _pick_column(raw_row, cm.get("product_hint"))
    has_card = _pick_column(raw_row, cm.get("has_card"))
    operator_alias = _pick_column(raw_row, cm.get("operator_alias"))

    normalized, valid = normalize_uz_phone(phone_raw)

    # Format-drift fallback: some srm rows added an "age" column between
    # product and name, shifting the phone rightward. If column_map's
    # position missed → scan the raw row for the last valid +998 number,
    # then pick the first alphabetic cell before it as the name.
    cells = raw_row.get("__cells__") or []
    phone_alt = ""
    if not valid:
        smart_phones, phone_col = _scan_row_for_phones(cells)
        if smart_phones:
            normalized, valid = smart_phones[0], True
            phone_raw = smart_phones[0]
            if len(smart_phones) > 1 and smart_phones[1] != smart_phones[0]:
                phone_alt = smart_phones[1]
            if not full_name or not any(ch.isalpha() for ch in full_name):
                smart_name = _scan_row_for_name(cells, phone_col_1based=phone_col)
                if smart_name:
                    full_name = smart_name
    else:
        # column_map hit — but the row may STILL have a second phone in a
        # neighbouring cell (new srm format has both a raw duplicate and
        # the +998-normalized one). Grab it into phone_alt if distinct.
        smart_phones, _ = _scan_row_for_phones(cells)
        for candidate in smart_phones:
            if candidate != normalized:
                phone_alt = candidate
                break
    metadata = _extract_metadata(raw_row, cm)

    default_status = sheet_source.default_status or LeadStatus.NEW
    needs_review = False
    status = mapped_sheet_status or default_status

    # Alias resolution + distribution routing:
    # First look up the alias (persist unknown ones so admin can bind them),
    # then apply `sheet_source.distribution_mode` to decide what to do when
    # the alias didn't produce a bound operator.
    alias = None
    alias_operator: Operator | None = None
    if operator_alias:
        alias = alias_lookup(operator_alias)
        if alias is None:
            OperatorSheetAlias.objects.get_or_create(alias_name=operator_alias.strip())
        else:
            alias_operator = alias.operator

    mode = sheet_source.distribution_mode or DistributionMode.ALIAS_ONLY
    default_op = sheet_source.default_operator
    if default_op is not None and default_op.status != OperatorStatus.ACTIVE:
        default_op = None

    assigned_op: Operator | None = None
    assignment_reason = ""
    use_round_robin = False

    if mode == DistributionMode.DEFAULT_ONLY:
        if default_op is not None:
            assigned_op = default_op
            assignment_reason = "default_only"
        else:
            needs_review = True
            status = LeadStatus.NEEDS_REVIEW
            assignment_reason = "default_only, но default_operator не задан/неактивен"
    elif alias_operator is not None:
        assigned_op = alias_operator
        assignment_reason = f"alias «{operator_alias}»"
    elif mode == DistributionMode.ALIAS_OR_DEFAULT and default_op is not None:
        assigned_op = default_op
        assignment_reason = "default_operator (fallback от alias_or_default)"
    elif mode == DistributionMode.ALIAS_OR_ROUND_ROBIN:
        use_round_robin = True
    elif operator_alias:
        # alias_only, либо alias_or_default без default: alias был задан,
        # но не разрезолвился → на ревью.
        needs_review = True
        status = LeadStatus.NEEDS_REVIEW
        if alias is None:
            assignment_reason = f"Неизвестный alias «{operator_alias}»"
        elif alias.operator is None:
            assignment_reason = f"Alias «{operator_alias}» не привязан к оператору"
    else:
        # alias пуст, mode=alias_only → историческое поведение: round-robin.
        use_round_robin = True

    if not valid:
        # Кривой телефон всегда перебивает автоматическое распределение.
        needs_review = True
        status = LeadStatus.NEEDS_REVIEW
        assigned_op = None
        use_round_robin = False

    if default_status == LeadStatus.ARCHIVED:
        # Archived rows (sheet 3 Bitrix export): skip auto-assignment and the
        # needs_review escalations — we're only importing them for history.
        needs_review = False
        status = LeadStatus.ARCHIVED
        assigned_op = None
        use_round_robin = False

    lead = Lead.objects.create(
        full_name=full_name[:128],
        phone_raw=phone_raw[:64],
        phone=normalized if valid else "",
        phone_alt=phone_alt[:16],
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
        LeadAssignment.objects.create(
            lead=lead,
            operator=assigned_op,
            source=LeadAssignmentSource.SHEET_MANUAL,
            reason=assignment_reason[:256],
        )
        if not needs_review:
            lead.status = LeadStatus.ASSIGNED
            lead.save(update_fields=["status", "updated_at"])
    elif use_round_robin and not needs_review and status == LeadStatus.NEW and valid:
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
    # New operator gets a fresh queue — clear the previous operator's postpone flag.
    lead.postponed_at = None
    lead.postponed_by = None
    lead.postpone_reason = ""
    lead.save(
        update_fields=[
            "operator",
            "needs_review",
            "status",
            "postponed_at",
            "postponed_by",
            "postpone_reason",
            "updated_at",
        ]
    )
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

    # Move any live callback reminders on this lead over to the new
    # operator. Without this the OLD operator keeps receiving DM nudges
    # for a lead that no longer belongs to them, and the NEW operator
    # never gets pinged. Local import avoids a leads<->calls cycle.
    from apps.calls.models import CallbackReminder, CallbackReminderStatus

    live_statuses = (
        CallbackReminderStatus.PENDING,
        CallbackReminderStatus.SNOOZED,
        CallbackReminderStatus.OVERDUE,
    )
    reassigned = CallbackReminder.objects.filter(
        lead=lead, status__in=live_statuses
    ).exclude(operator_id=new_operator.id).update(
        # Reset dm_sent_at so the new operator gets a fresh DM at the
        # next cron tick — the old row's timestamp belongs to a message
        # sent to a different person.
        operator=new_operator,
        dm_sent_at=None,
    )
    if reassigned:
        audit_log_create(
            user=user,
            action=AuditAction.UPDATE,
            entity="calls.CallbackReminder",
            entity_id=lead.id,  # anchor to the lead — reminders are plural
            changes={
                "reassigned_to": new_operator.id,
                "old_operator_id": old_op.id if old_op else None,
                "count": reassigned,
                "lead_id": lead.id,
            },
            comment="Reminders moved with lead reassignment",
        )

    _schedule_writeback(
        lead.id,
        comment=f"Переназначен → {new_operator.full_name}"
        + (f" ({reason})" if reason else ""),
    )
    return assignment


@transaction.atomic
def lead_update_status(
    *,
    lead: Lead,
    status: str,
    user=None,
    comment: str = "",
    skip_retry: bool = False,
) -> Lead:
    # Historic enum values stay valid; on top of them we accept any
    # currently-active LeadStatusLabel code (custom manager-created ones).
    if status not in dict(LeadStatus.choices):
        from .models import LeadStatusLabel

        if not LeadStatusLabel.objects.filter(code=status, is_active=True).exists():
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
    _schedule_writeback(lead.id, comment=comment)
    # Qimmatlik → auto-reassign to a fresh operator (once). skip_retry
    # is the recursion-guard used by lead_qimmatlik_retry itself when it
    # decides to close as LOST.
    if status == "qimmatlik_qildi" and not skip_retry:
        lead_id = lead.id
        transaction.on_commit(lambda: _run_qimmatlik_retry(lead_id))
    return lead


def _run_qimmatlik_retry(lead_id: int) -> None:
    """
    Thin wrapper: refetch the lead in a fresh transaction so we don't
    reuse a stale in-memory instance from the outer atomic block, then
    delegate to lead_qimmatlik_retry.
    """
    try:
        fresh = Lead.objects.select_related("operator").filter(pk=lead_id).first()
        if fresh is None:
            return
        lead_qimmatlik_retry(fresh)
    except Exception:
        logger.exception("qimmatlik retry failed lead=%s", lead_id)


@transaction.atomic
def lead_qimmatlik_retry(lead: Lead) -> Operator | None:
    """
    Called from lead_update_status when status flipped to
    'qimmatlik_qildi'. Picks a fresh operator (RR among those who
    haven't already touched this lead) and reassigns; if none left →
    close as LOST with a diagnostic comment.
    """
    from django.db.models import Count, Q

    from .selectors import ACTIVE_LEAD_STATUSES, operators_eligible_for_new_leads

    previous_ids = list(
        lead.assignments.values_list("operator_id", flat=True).distinct()
    )
    from_op_id = lead.operator_id

    candidate = (
        operators_eligible_for_new_leads()
        .exclude(pk__in=previous_ids)
        .annotate(
            active_leads_count=Count(
                "leads", filter=Q(leads__status__in=ACTIVE_LEAD_STATUSES)
            )
        )
        .order_by("active_leads_count", "id")
        .first()
    )
    if candidate is None:
        lead_update_status(
            lead=lead,
            status=LeadStatus.LOST,
            comment="qimmatlik: все операторы уже пробовали",
            skip_retry=True,
        )
        return None

    lead.assignments.filter(active=True).update(active=False)
    LeadAssignment.objects.create(
        lead=lead,
        operator=candidate,
        source=LeadAssignmentSource.QIMMATLIK_RETRY,
        active=True,
        reason=f"retry after qimmatlik from op#{from_op_id}",
    )
    lead.operator = candidate
    lead.status = LeadStatus.ASSIGNED
    lead.postponed_at = None
    lead.postponed_by = None
    lead.postpone_reason = ""
    lead.save(
        update_fields=[
            "operator",
            "status",
            "postponed_at",
            "postponed_by",
            "postpone_reason",
            "updated_at",
        ]
    )
    _schedule_writeback(
        lead.id,
        comment=f"qimmatlik retry → {candidate.full_name}",
    )
    return candidate


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

    # Guard against a second conversion on the same lead: nothing at the
    # DB level enforces uniqueness because a Sale.lead FK is nullable and
    # shared with historical/backfilled sales. Without this check the
    # caller could double-create and silently over-count the pipeline.
    if lead.sales.filter(is_deleted=False).exists():
        raise ApplicationError(
            "Этот лид уже конвертирован в продажу",
            {"field": "lead", "reason": "already_converted"},
        )

    if not sale_data.get("operators") and not sale_data.get("operator_id"):
        if lead.operator_id is None:
            raise ApplicationError(
                "У лида нет оператора — назначьте его перед конвертацией",
                {"field": "operator"},
            )
        sale_data = {**sale_data, "operator_id": lead.operator_id}

    # Auto-propagate sheet_source from lead so analytics can attribute the
    # sale to a targetolog without waiting for a manual pick.
    if not sale_data.get("sheet_source_id") and lead.sheet_source_id:
        sale_data = {**sale_data, "sheet_source_id": lead.sheet_source_id}

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
    _schedule_writeback(
        lead.id,
        comment=(sale.bonus_note or f"→ Sale #{sale.id}"),
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
    default_operator: Operator | None = None,
    distribution_mode: str = DistributionMode.ALIAS_ONLY,
    writeback_columns: dict | None = None,
    user=None,
) -> SheetSource:
    defaults = {
        "name": name[:128],
        "worksheet_name": worksheet_name[:128],
        "column_map": column_map,
        "default_status": default_status,
        "active": active,
        "default_operator": default_operator,
        "distribution_mode": distribution_mode,
    }
    if writeback_columns is not None:
        defaults["writeback_columns"] = writeback_columns
    obj, created = SheetSource.objects.update_or_create(
        spreadsheet_id=spreadsheet_id,
        gid=gid,
        defaults=defaults,
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
            "default_operator_id": obj.default_operator_id,
            "distribution_mode": obj.distribution_mode,
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


@transaction.atomic
def lead_postpone(*, lead: Lead, operator: Operator, reason: str = "", user=None) -> Lead:
    if lead.operator_id != operator.id:
        raise ApplicationError("Можно откладывать только свои лиды")
    if lead.postponed_at is not None:
        raise ApplicationError("Лид уже отложен")
    lead.postponed_at = timezone.now()
    lead.postponed_by = operator
    lead.postpone_reason = (reason or "").strip()[:280]
    lead.save(update_fields=["postponed_at", "postponed_by", "postpone_reason", "updated_at"])
    audit_log_create(
        user=user,
        action=AuditAction.UPDATE,
        entity="leads.Lead",
        entity_id=lead.id,
        changes={
            "postponed_at": str(lead.postponed_at),
            "operator_id": operator.id,
            "reason": lead.postpone_reason,
        },
        comment="postponed by operator",
    )
    _schedule_writeback(
        lead.id,
        comment=f"Отложен: {lead.postpone_reason}" if lead.postpone_reason else "Отложен",
    )
    return lead


@transaction.atomic
def lead_unpostpone(*, lead: Lead, operator: Operator, user=None) -> Lead:
    if lead.operator_id != operator.id:
        raise ApplicationError("Можно возвращать только свои лиды")
    if lead.postponed_at is None:
        raise ApplicationError("Лид не отложен")
    old = {"postponed_at": str(lead.postponed_at), "postponed_by_id": lead.postponed_by_id}
    lead.postponed_at = None
    lead.postponed_by = None
    lead.postpone_reason = ""
    lead.save(update_fields=["postponed_at", "postponed_by", "postpone_reason", "updated_at"])
    audit_log_create(
        user=user,
        action=AuditAction.UPDATE,
        entity="leads.Lead",
        entity_id=lead.id,
        changes={"unpostponed": old},
        comment="unpostponed by operator",
    )
    _schedule_writeback(lead.id, comment="Возвращён в работу")
    return lead

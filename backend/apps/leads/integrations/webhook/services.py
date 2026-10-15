"""
Webhook lead sources: source management + inbound processing.

Inbound flow per record (see `inbound_lead_process`):
  1. `parse.parse_lead` → name / phone / product / ad attribution / extra;
  2. no phone and no name → journal `invalid`, 400 for the sender;
  3. repeat `external_id` for this source → journal `duplicate`, no lead;
  4. `lead_create_from_webhook` (same routing as a sheet row of the source)
     + journal row in ONE transaction — the conditional unique constraint
     on (source, external_id) turns a concurrent double-POST into
     `duplicate` instead of two leads.
"""

from __future__ import annotations

import json
import logging
import secrets
from dataclasses import dataclass
from typing import Any

from django.db import IntegrityError, transaction
from django.utils import timezone

from apps.audit.services import AuditAction, audit_log_create
from apps.common.exceptions import ApplicationError
from apps.leads.models import (
    DistributionMode,
    InboundLeadEvent,
    InboundLeadEventOutcome,
    LeadStatus,
    SheetSource,
    SheetSourceKind,
)
from apps.leads.services import lead_create_from_webhook

from .parse import extract_records, parse_lead

logger = logging.getLogger("leads.webhook")

# Сырой payload в журнале обрезаем — тела недоверенные.
MAX_JOURNAL_PAYLOAD = 16 * 1024
WEBHOOK_URL_PREFIX = "/api/integrations/leads/"


def webhook_path(token: str) -> str:
    return f"{WEBHOOK_URL_PREFIX}{token}/"


def _new_token() -> str:
    return secrets.token_urlsafe(24)


# ---- source management ---------------------------------------------------


@transaction.atomic
def webhook_source_create(
    *,
    name: str,
    is_hot: bool = False,
    hot_sla_minutes: int = 10,
    operator_ids: list[int] | None = None,
    distribution_mode: str = DistributionMode.ALIAS_OR_ROUND_ROBIN,
    default_status: str = LeadStatus.NEW,
    default_operator=None,
    active: bool = True,
    user=None,
) -> SheetSource:
    name = (name or "").strip()[:128]
    if not name:
        raise ApplicationError("Название источника обязательно", {"field": "name"})
    if distribution_mode not in DistributionMode.values:
        raise ApplicationError("Неизвестный режим раздачи", {"field": "distribution_mode"})
    src = SheetSource.objects.create(
        name=name,
        kind=SheetSourceKind.WEBHOOK,
        spreadsheet_id="",
        gid=0,
        column_map={},
        default_status=default_status,
        active=active,
        default_operator=default_operator,
        distribution_mode=distribution_mode,
        writeback_columns={"enabled": False},
        is_hot=is_hot,
        hot_sla_minutes=hot_sla_minutes,
        webhook_token=_new_token(),
        outbound_config={"url": "", "api_key": "", "enabled": False},
    )
    if operator_ids:
        src.allowed_operators.set(operator_ids)
    audit_log_create(
        user=user,
        action=AuditAction.CREATE,
        entity="leads.SheetSource",
        entity_id=src.id,
        changes={
            "name": src.name,
            "kind": src.kind,
            "is_hot": src.is_hot,
            "distribution_mode": src.distribution_mode,
            "allowed_operator_ids": list(operator_ids or []),
        },
        comment="Webhook-источник лидов",
    )
    return src


@transaction.atomic
def webhook_source_rotate_token(*, source: SheetSource, user=None) -> SheetSource:
    if source.kind != SheetSourceKind.WEBHOOK:
        raise ApplicationError("Источник не webhook", {"field": "kind"})
    source.webhook_token = _new_token()
    source.save(update_fields=["webhook_token", "updated_at"])
    audit_log_create(
        user=user,
        action=AuditAction.UPDATE,
        entity="leads.SheetSource",
        entity_id=source.id,
        changes={"webhook_token": "rotated"},
        comment="Ротация webhook-токена",
    )
    return source


def outbound_config_merge(current: dict | None, incoming: dict | None) -> dict:
    """
    PATCH semantics for `outbound_config`: only url / api_key / enabled;
    a masked api_key coming back from the UI (contains «•») keeps the old one.
    """
    merged = {"url": "", "api_key": "", "enabled": False, **(current or {})}
    for key, value in (incoming or {}).items():
        if key == "api_key":
            if value is None or "•" in str(value):
                continue
            merged["api_key"] = str(value).strip()[:512]
        elif key == "url":
            merged["url"] = str(value or "").strip()[:512]
        elif key == "enabled":
            merged["enabled"] = bool(value)
    return merged


def outbound_config_masked(config: dict | None) -> dict:
    cfg = {"url": "", "api_key": "", "enabled": False, **(config or {})}
    key = str(cfg.get("api_key") or "")
    cfg["api_key"] = f"••••{key[-4:]}" if key else ""
    return cfg


@transaction.atomic
def webhook_source_update(
    *,
    source: SheetSource,
    data: dict,
    allowed_operator_ids: list[int] | None = None,
    user=None,
) -> SheetSource:
    """
    Edit a webhook source from the manager UI. Google-only fields
    (spreadsheet_id / gid / worksheet / column_map / writeback) are ignored.
    """
    editable = (
        "name",
        "default_status",
        "active",
        "default_operator",
        "distribution_mode",
        "is_hot",
        "hot_sla_minutes",
    )
    changed: dict[str, Any] = {}
    for field in editable:
        if field in data:
            setattr(source, field, data[field])
            changed[field] = data[field].id if hasattr(data[field], "id") else data[field]
    if "outbound_config" in data:
        source.outbound_config = outbound_config_merge(source.outbound_config, data["outbound_config"])
        changed["outbound_config"] = outbound_config_masked(source.outbound_config)
    source.save()
    if allowed_operator_ids is not None:
        source.allowed_operators.set(allowed_operator_ids)
        changed["allowed_operator_ids"] = allowed_operator_ids
    audit_log_create(
        user=user,
        action=AuditAction.UPDATE,
        entity="leads.SheetSource",
        entity_id=source.id,
        changes=changed,
    )
    return source


# ---- inbound -------------------------------------------------------------


@dataclass
class InboundResult:
    ok: bool
    outcome: str
    lead_id: int | None = None
    error: str = ""

    def as_dict(self) -> dict:
        out: dict[str, Any] = {"ok": self.ok, "lead_id": self.lead_id, "result": self.outcome}
        if self.error:
            out["error"] = self.error
        return out


def _journal_payload(payload: Any) -> Any:
    try:
        text = json.dumps(payload, ensure_ascii=False, default=str)
    except (TypeError, ValueError):
        text = str(payload)
    if len(text) <= MAX_JOURNAL_PAYLOAD:
        return payload if isinstance(payload, (dict, list)) else {"_raw": text}
    return {"_truncated": True, "_raw": text[:MAX_JOURNAL_PAYLOAD]}


def inbound_journal(
    *,
    source: SheetSource,
    payload: Any,
    outcome: str,
    external_id: str = "",
    lead=None,
    error: str = "",
    remote_ip: str | None = None,
) -> InboundLeadEvent:
    return InboundLeadEvent.objects.create(
        source=source,
        external_id=external_id,
        payload=_journal_payload(payload),
        lead=lead,
        outcome=outcome,
        error=error[:2000],
        remote_ip=remote_ip,
    )


def _duplicate(source: SheetSource, record: dict, external_id: str, remote_ip) -> InboundResult:
    prior = (
        InboundLeadEvent.objects.filter(source=source, external_id=external_id)
        .order_by("id")
        .first()
    )
    lead_id = prior.lead_id if prior else None
    # external_id не пишем — он уже занят исходной записью (unique).
    inbound_journal(
        source=source,
        payload=record,
        outcome=InboundLeadEventOutcome.DUPLICATE,
        lead=prior.lead if prior else None,
        error=f"repeat external_id={external_id}",
        remote_ip=remote_ip,
    )
    return InboundResult(ok=True, outcome=InboundLeadEventOutcome.DUPLICATE, lead_id=lead_id)


def inbound_lead_process(*, source: SheetSource, record: dict, remote_ip: str | None = None) -> InboundResult:
    parsed = parse_lead(record)
    if parsed.is_empty:
        err = "no phone and no name in payload"
        inbound_journal(
            source=source,
            payload=record,
            outcome=InboundLeadEventOutcome.INVALID,
            error=err,
            remote_ip=remote_ip,
        )
        return InboundResult(ok=False, outcome=InboundLeadEventOutcome.INVALID, error=err)

    ext = parsed.external_id
    if ext and InboundLeadEvent.objects.filter(source=source, external_id=ext).exists():
        return _duplicate(source, record, ext, remote_ip)

    metadata: dict[str, Any] = {}
    if parsed.ad:
        metadata["ad"] = parsed.ad
    if parsed.extra:
        metadata["extra"] = parsed.extra

    try:
        with transaction.atomic():
            lead, outcome = lead_create_from_webhook(
                source=source,
                full_name=parsed.full_name,
                phone_raw=parsed.phone_raw,
                product_hint=parsed.product_hint,
                has_card=parsed.has_card,
                metadata=metadata,
                external_id=ext,
            )
            if outcome == "created" and lead.needs_review:
                outcome = InboundLeadEventOutcome.NEEDS_REVIEW
            inbound_journal(
                source=source,
                payload=record,
                outcome=outcome,
                external_id=ext,
                lead=lead,
                remote_ip=remote_ip,
            )
            SheetSource.objects.filter(pk=source.pk).update(
                last_synced_at=timezone.now(), last_sync_error=""
            )
    except IntegrityError:
        if ext and InboundLeadEvent.objects.filter(source=source, external_id=ext).exists():
            # Параллельный повтор того же лида успел раньше.
            return _duplicate(source, record, ext, remote_ip)
        logger.exception("webhook source=%s: integrity error", source.id)
        return _error(source, record, remote_ip, "integrity error")
    except Exception as exc:  # sender must get a 500 to retry
        logger.exception("webhook source=%s: lead create failed", source.id)
        return _error(source, record, remote_ip, f"{type(exc).__name__}: {exc}")
    return InboundResult(ok=True, outcome=outcome, lead_id=lead.id)


def _error(source: SheetSource, record: dict, remote_ip, err: str) -> InboundResult:
    try:
        inbound_journal(
            source=source,
            payload=record,
            outcome=InboundLeadEventOutcome.ERROR,
            error=err,
            remote_ip=remote_ip,
        )
    except Exception:
        logger.exception("webhook source=%s: journal write failed", source.id)
    return InboundResult(ok=False, outcome=InboundLeadEventOutcome.ERROR, error="internal error")


def inbound_leads_process(
    *, source: SheetSource, body: Any, remote_ip: str | None = None
) -> tuple[list[InboundResult], bool]:
    """
    Whole request body → per-record results. Returns (results, is_batch);
    `is_batch` = the sender posted an array / envelope, so the response
    should be a `results` list.
    """
    records = extract_records(body)
    is_batch = isinstance(body, list) or len(records) > 1
    if not records:
        err = "no lead object in body"
        inbound_journal(
            source=source,
            payload=body,
            outcome=InboundLeadEventOutcome.INVALID,
            error=err,
            remote_ip=remote_ip,
        )
        return [InboundResult(ok=False, outcome=InboundLeadEventOutcome.INVALID, error=err)], False
    return [
        inbound_lead_process(source=source, record=rec, remote_ip=remote_ip) for rec in records
    ], is_batch

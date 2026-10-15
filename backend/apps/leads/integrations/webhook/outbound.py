"""
«Статусы обратно» для webhook-источников (LeadPixel: лиды → продажи → ROAS).

Сервисы лидов/продаж зовут `outbound_schedule(...)`; событие пишется в
`LeadOutboundEvent` только после commit'а и только если лид относится к
webhook-источнику (его `sheet_source.kind == webhook` или он был склеен с
заявкой из такого источника — `metadata["duplicate_webhook_events"]`).
Payload собирается в момент commit'а из ТЕКУЩЕГО состояния лида/продажи.

Доставку делает `process_lead_outbound` — и только для источников с
`outbound_config.enabled=true` и url. `_deliver` — ВРЕМЕННЫЙ адаптер:
формат LeadPixel неизвестен, пока шлём наш JSON с Bearer-ключом.

Ничего отсюда не должно ронять основной путь (статус / продажа):
всё обёрнуто и логируется.
"""

from __future__ import annotations

import logging

from django.db import transaction
from django.utils import timezone

logger = logging.getLogger("leads.webhook.outbound")

CURRENCY = "UZS"
DELIVERY_TIMEOUT_S = 10.0


def outbound_schedule(*, lead_id: int | None, kind: str, sale_id: int | None = None) -> None:
    """Queue an outbound event once the surrounding transaction commits."""
    if not lead_id:
        return
    transaction.on_commit(lambda: _enqueue_safe(lead_id, kind, sale_id))


def _enqueue_safe(lead_id: int, kind: str, sale_id: int | None) -> None:
    try:
        outbound_enqueue_now(lead_id=lead_id, kind=kind, sale_id=sale_id)
    except Exception:
        logger.exception("outbound enqueue failed lead=%s kind=%s sale=%s", lead_id, kind, sale_id)


def webhook_sources_for_lead(lead) -> list:
    """Webhook sources this lead must be reported to (primary + merged)."""
    from apps.leads.models import SheetSource, SheetSourceKind

    ids: list[int] = []
    if lead.sheet_source_id:
        ids.append(lead.sheet_source_id)
    for entry in (lead.metadata or {}).get("duplicate_webhook_events") or []:
        sid = entry.get("source_id") if isinstance(entry, dict) else None
        if isinstance(sid, int) and sid not in ids:
            ids.append(sid)
    if not ids:
        return []
    return list(
        SheetSource.objects.filter(pk__in=ids, kind=SheetSourceKind.WEBHOOK).order_by("id")
    )


def _external_ids_for(lead, source) -> list[str]:
    """leadgen_id/lead_id/id this source gave us for the lead (newest last)."""
    out: list[str] = []
    md = lead.metadata or {}
    if lead.sheet_source_id == source.id:
        ad = md.get("ad") or {}
        for key in ("leadgen_id", "lead_id", "id"):
            if ad.get(key):
                out.append(str(ad[key]))
                break
    for entry in md.get("duplicate_webhook_events") or []:
        if isinstance(entry, dict) and entry.get("source_id") == source.id and entry.get("external_id"):
            if str(entry["external_id"]) not in out:
                out.append(str(entry["external_id"]))
    if not out:
        from apps.leads.models import InboundLeadEvent

        ext = (
            InboundLeadEvent.objects.filter(source=source, lead=lead)
            .exclude(external_id="")
            .order_by("-received_at")
            .values_list("external_id", flat=True)
            .first()
        )
        if ext:
            out.append(ext)
    return out


def build_payload(*, lead, source, kind: str, sale=None) -> dict:
    from apps.leads.models import LeadStatusLabel

    label = (
        LeadStatusLabel.objects.filter(code=lead.status).values_list("label_ru", flat=True).first()
        or lead.status
    )
    ext_ids = _external_ids_for(lead, source)
    payload = {
        "event": kind,
        "lead_id": lead.id,
        "external_id": ext_ids[0] if ext_ids else "",
        "external_ids": ext_ids,
        "phone": lead.phone or lead.phone_raw,
        "status": lead.status,
        "status_label": label,
        "operator": lead.operator.full_name if lead.operator_id else "",
        "amount_uzs": None,
        "currency": CURRENCY,
        "occurred_at": timezone.now().isoformat(),
    }
    if sale is not None:
        payload["sale_id"] = sale.id
        payload["amount_uzs"] = int((sale.amount or 0) - (sale.discount or 0))
    return payload


def outbound_enqueue_now(*, lead_id: int, kind: str, sale_id: int | None = None) -> int:
    """
    Write LeadOutboundEvent rows for every webhook source of the lead.
    Returns how many were created. Dedup:
      * status — skip when the last status event for (source, lead) already
        carries this status;
      * sale / sale_returned — one event per sale per source; a sale event
        is emitted only for CONFIRMED, not-deleted sales (pending ones are
        reported by `sale_confirm`).
    """
    from apps.leads.models import Lead, LeadOutboundEvent, LeadOutboundEventKind

    lead = Lead.objects.select_related("operator").filter(pk=lead_id).first()
    if lead is None:
        return 0
    sources = webhook_sources_for_lead(lead)
    if not sources:
        return 0

    sale = None
    if kind in (LeadOutboundEventKind.SALE, LeadOutboundEventKind.SALE_RETURNED):
        from apps.sales.models import Sale, SaleStatus

        sale = Sale.objects.filter(pk=sale_id).first() if sale_id else None
        if sale is None or sale.is_deleted:
            return 0
        if kind == LeadOutboundEventKind.SALE and sale.status != SaleStatus.CONFIRMED:
            return 0
        dedupe_key = f"{kind}:{sale.id}"
    else:
        kind = LeadOutboundEventKind.STATUS
        dedupe_key = f"status:{lead.status}"

    created = 0
    for source in sources:
        if kind == LeadOutboundEventKind.STATUS:
            last = (
                LeadOutboundEvent.objects.filter(source=source, lead=lead, kind=kind)
                .order_by("-id")
                .values_list("dedupe_key", flat=True)
                .first()
            )
            if last == dedupe_key:
                continue
        elif LeadOutboundEvent.objects.filter(
            source=source, lead=lead, dedupe_key=dedupe_key
        ).exists():
            continue
        LeadOutboundEvent.objects.create(
            source=source,
            lead=lead,
            kind=kind,
            dedupe_key=dedupe_key,
            payload=build_payload(lead=lead, source=source, kind=kind, sale=sale),
        )
        created += 1
    return created


def outbound_config_ready(config: dict | None) -> bool:
    cfg = config or {}
    url = str(cfg.get("url") or "")
    return bool(cfg.get("enabled")) and url.startswith(("http://", "https://"))


def _deliver(event, config: dict) -> None:
    """
    PROVISIONAL HTTP adapter — LeadPixel has not given us its endpoint /
    key / format yet. POSTs our payload as JSON, `Authorization: Bearer
    <api_key>` when a key is set; any 2xx = delivered, anything else
    raises (the worker retries with backoff). Replace the body once the
    real contract is known.
    """
    import httpx

    headers = {"Content-Type": "application/json"}
    api_key = str(config.get("api_key") or "")
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    resp = httpx.post(
        str(config["url"]),
        json=event.payload,
        headers=headers,
        timeout=DELIVERY_TIMEOUT_S,
    )
    if not (200 <= resp.status_code < 300):
        raise RuntimeError(f"HTTP {resp.status_code}: {resp.text[:200]}")

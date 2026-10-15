"""
«Статусы обратно» в LeadPixel (official spec, 2026-10-15).

    POST https://leadpixel-production.up.railway.app/api/crm/inbound
    X-API-Key: lp_…            (outbound_config.api_key, «Ключ для CRM»)
    {"events": [{"id": "<наш lead id>", "status": "new|qualified|won|lost|junk",
                 "stage": "<наш ярлык статуса>", "meta_lead_id": …,
                 "amount": 4000000, "currency": "UZS", "at": "<ISO>", …}]}

Their model is «current status per lead»: one lead = one sale (won +
amount, dated by `at`), re-sending won with another amount updates it,
moving a won lead to any other status cancels the sale.

So every hook (status change, sale, return, reject, merge) just snapshots
the lead's CURRENT LeadPixel state on commit (`leadpixel_event`) into
`LeadOutboundEvent`; an identical state in a row is skipped. The sender
(`process_lead_outbound`) sends only the latest pending snapshot per lead.

Rules of the snapshot:
  * a confirmed, not returned, not deleted sale → `won` + amount
    (amount − discount) + `at` = sold_at, whatever status hook fired;
  * our status `won` but no live sale: a pending sale → `qualified`
    («на подтверждении»); a returned / rejected / deleted sale → `lost`
    with stage «Возврат» (cancels their sale);
  * otherwise `map_status` (defaults below, per-source override in
    `outbound_config["status_map"]`), junk for wrong numbers.

Nothing here may break the main path: hooks are wrapped and logged.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from decimal import Decimal
from email.utils import parsedate_to_datetime

from django.db import transaction
from django.utils import timezone

logger = logging.getLogger("leads.webhook.outbound")

LEADPIXEL_DEFAULT_URL = "https://leadpixel-production.up.railway.app/api/crm/inbound"
LEADPIXEL_STATUSES = ("new", "qualified", "won", "lost", "junk")
CURRENCY = "UZS"
DELIVERY_TIMEOUT_S = 15.0
MAX_BATCH_EVENTS = 200
# Лимит LeadPixel — 256 КБ на запрос; держим запас под обёртку.
MAX_BATCH_BYTES = 250 * 1024
REFUND_STAGE = "Возврат"
# Без Retry-After: 60 с, дальше медленнее (до часа).
BACKOFF_DEFAULT = [
    timedelta(seconds=60),
    timedelta(minutes=2),
    timedelta(minutes=10),
    timedelta(hours=1),
]

# Наш код статуса → статус LeadPixel. Неизвестные (кастомные LeadStatusLabel)
# коды: терминальный → lost, иначе qualified. Перекрывается per-source
# через outbound_config["status_map"] = {"<код>": "<lp-статус>"}.
DEFAULT_STATUS_MAP: dict[str, str] = {
    "new": "new",
    "assigned": "new",
    "no_answer": "new",
    "no_answer_2": "new",
    "needs_review": "new",
    "in_progress": "qualified",
    "callback_scheduled": "qualified",
    "contacted_telegram": "qualified",
    "phone_on": "qualified",
    "won": "won",
    "lost": "lost",
    "archived": "lost",
    "has_debt": "lost",
    # Кастомный терминальный статус «noto'g'ri raqam» (миграция 0026) —
    # неверный номер, это мусор, а не отказ.
    "notogri_raqam": "junk",
}


def _junk_lost_reasons() -> frozenset[str]:
    # Из системных lost-причин «неверный номер» — только битый телефон;
    # stranded_on_inactive_operator — это наш сбой, не мусорный лид.
    from apps.leads.selectors import LOST_REASON_INVALID_PHONE

    return frozenset({LOST_REASON_INVALID_PHONE})


# ---- hooks / enqueue -----------------------------------------------------


def outbound_schedule(*, lead_id: int | None, kind: str, sale_id: int | None = None) -> None:
    """Snapshot the lead's LeadPixel state once the transaction commits."""
    if not lead_id:
        return
    transaction.on_commit(lambda: _enqueue_safe(lead_id, kind))


def _enqueue_safe(lead_id: int, kind: str) -> None:
    try:
        outbound_enqueue_now(lead_id=lead_id, kind=kind)
    except Exception:
        logger.exception("outbound enqueue failed lead=%s kind=%s", lead_id, kind)


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


def _attribution_for(lead, source) -> tuple[str, dict]:
    """(meta_lead_id, ad-dict) this source gave us for the lead."""
    md = lead.metadata or {}
    meta_id = ""
    ad: dict = {}
    if lead.sheet_source_id == source.id:
        ad = md.get("ad") or {}
        for key in ("meta_lead_id", "leadgen_id", "lead_id", "id"):
            if ad.get(key):
                meta_id = str(ad[key])
                break
    for entry in md.get("duplicate_webhook_events") or []:
        if isinstance(entry, dict) and entry.get("source_id") == source.id:
            if not meta_id and entry.get("external_id"):
                meta_id = str(entry["external_id"])
            if not ad and isinstance(entry.get("ad"), dict):
                ad = entry["ad"]
    if not meta_id:
        from apps.leads.models import InboundLeadEvent

        meta_id = (
            InboundLeadEvent.objects.filter(source=source, lead=lead)
            .exclude(external_id="")
            .order_by("received_at")
            .values_list("external_id", flat=True)
            .first()
        ) or ""
    return meta_id, ad


def status_map_for(source) -> dict[str, str]:
    overrides = (source.outbound_config or {}).get("status_map") or {}
    out = dict(DEFAULT_STATUS_MAP)
    if isinstance(overrides, dict):
        out.update({str(k): str(v) for k, v in overrides.items() if str(v) in LEADPIXEL_STATUSES})
    return out


def map_status(lead, source) -> str:
    """Our lead → one of LEADPIXEL_STATUSES (ignores sales — see leadpixel_event)."""
    if lead.phone_invalid:
        return "junk"
    if (lead.metadata or {}).get("lost_reason") in _junk_lost_reasons():
        return "junk"
    mapping = status_map_for(source)
    if lead.status in mapping:
        return mapping[lead.status]
    from apps.leads.models import LeadStatusLabel

    terminal = LeadStatusLabel.objects.filter(code=lead.status, is_terminal=True).exists()
    return "lost" if terminal else "qualified"


def _status_label(code: str) -> str:
    from apps.leads.models import LeadStatus, LeadStatusLabel

    return (
        LeadStatusLabel.objects.filter(code=code).values_list("label_ru", flat=True).first()
        or dict(LeadStatus.choices).get(code)
        or code
    )


def _plain_amount(value: Decimal) -> int | float:
    value = max(Decimal("0"), value)
    return int(value) if value == value.to_integral_value() else float(value)


def _iso(value: datetime | None) -> str:
    return value.isoformat() if value else ""


def leadpixel_event(lead, source, *, at: datetime | None = None) -> dict:
    """The lead's current state as one LeadPixel event object."""
    from apps.sales.models import Sale, SaleStatus

    sales = Sale.objects.filter(lead=lead)
    live_sale = (
        sales.filter(is_deleted=False, is_returned=False, status=SaleStatus.CONFIRMED)
        .order_by("-sold_at", "-id")
        .first()
    )
    amount = None
    if live_sale is not None:
        status = "won"
        stage = _status_label("won")
        amount = _plain_amount((live_sale.amount or Decimal("0")) - (live_sale.discount or Decimal("0")))
        at = live_sale.sold_at
    else:
        status = map_status(lead, source)
        stage = _status_label(lead.status)
        if status == "won" and sales.exists():
            if sales.filter(is_deleted=False, is_returned=False, status=SaleStatus.PENDING).exists():
                # Продажа ещё не подтверждена — не заявляем её LeadPixel'ю.
                status, stage = "qualified", f"{stage} (на подтверждении)"
            else:
                # Продажа возвращена / отклонена / удалена, а лид всё ещё
                # won у нас → для LeadPixel это отмена продажи.
                status, stage = "lost", REFUND_STAGE

    meta_lead_id, ad = _attribution_for(lead, source)
    obj = {
        "id": str(lead.id),
        "status": status,
        "stage": stage,
        "meta_lead_id": meta_lead_id,
        "phone": lead.phone or lead.phone_raw,
        "name": lead.full_name,
        "source": ad.get("source") or "",
        "amount": amount,
        "currency": CURRENCY if amount is not None else "",
        "at": _iso(at or timezone.now()),
        "created_at": _iso(lead.created_at),
        "ad_id": ad.get("ad_id") or "",
        "utm_source": ad.get("utm_source") or "",
        "utm_campaign": ad.get("utm_campaign") or "",
        "utm_content": ad.get("utm_content") or "",
    }
    return {k: v for k, v in obj.items() if v not in (None, "")}


def _signature(obj: dict) -> str:
    return f"{obj['status']}|{obj.get('stage', '')}|{obj.get('amount', '')}"[:128]


def outbound_enqueue_now(*, lead_id: int, kind: str = "status", sale_id: int | None = None) -> int:
    """
    Snapshot the lead for every webhook source it belongs to. Skips a
    source when its last event already carries the same state. Returns how
    many events were created.
    """
    from apps.leads.models import Lead, LeadOutboundEvent, LeadOutboundEventKind

    lead = Lead.objects.filter(pk=lead_id).first()
    if lead is None:
        return 0
    sources = webhook_sources_for_lead(lead)
    if not sources:
        return 0
    if kind not in LeadOutboundEventKind.values:
        kind = LeadOutboundEventKind.STATUS

    created = 0
    for source in sources:
        obj = leadpixel_event(lead, source)
        sig = _signature(obj)
        last = (
            LeadOutboundEvent.objects.filter(source=source, lead=lead)
            .order_by("-id")
            .values_list("dedupe_key", flat=True)
            .first()
        )
        if last == sig:
            continue
        LeadOutboundEvent.objects.create(
            source=source, lead=lead, kind=kind, dedupe_key=sig, payload=obj
        )
        created += 1
    return created


# ---- delivery ------------------------------------------------------------


def outbound_config_ready(config: dict | None) -> bool:
    cfg = config or {}
    url = str(cfg.get("url") or LEADPIXEL_DEFAULT_URL)
    return bool(cfg.get("enabled")) and bool(cfg.get("api_key")) and url.startswith(
        ("http://", "https://")
    )


def outbound_url(config: dict | None) -> str:
    return str((config or {}).get("url") or LEADPIXEL_DEFAULT_URL)


@dataclass
class DeliveryResult:
    """
    outcome:
      * "ok"    — 2xx; `results` = their per-event results;
      * "final" — 400/401/other non-retryable 4xx: don't retry;
                  `item_errors` = {index: reason} when the 400 names items;
      * "retry" — 408/425/429/5xx/timeout/network; `retry_after` seconds
                  when the server said so.
    """

    outcome: str
    status_code: int | None = None
    body: str = ""
    retry_after: float | None = None
    results: list[dict] = field(default_factory=list)
    item_errors: dict[int, str] = field(default_factory=dict)


_RETRYABLE = {408, 425, 429}


def _parse_retry_after(value: str | None) -> float | None:
    if not value:
        return None
    value = value.strip()
    try:
        secs = float(value)
    except ValueError:
        try:
            secs = (parsedate_to_datetime(value) - timezone.now()).total_seconds()
        except (TypeError, ValueError):
            return None
    return max(1.0, min(secs, 3600.0))


def _item_errors(body: str, n: int) -> dict[int, str]:
    """400 → {"errors": [{"index": 3, "reason": "…"}]} (key names tolerant)."""
    try:
        data = json.loads(body)
    except ValueError:
        return {}
    errors = data.get("errors") if isinstance(data, dict) else None
    out: dict[int, str] = {}
    for err in errors or []:
        if not isinstance(err, dict):
            continue
        idx = err.get("index", err.get("i", err.get("item")))
        if isinstance(idx, int) and 0 <= idx < n:
            out[idx] = str(err.get("reason") or err.get("error") or err.get("message") or "invalid")[:300]
    return out


def _deliver(objects: list[dict], config: dict) -> DeliveryResult:
    """POST a batch to LeadPixel `/api/crm/inbound` and classify the answer."""
    import httpx

    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "X-API-Key": str(config.get("api_key") or ""),
    }
    try:
        resp = httpx.post(
            outbound_url(config),
            json={"events": objects},
            headers=headers,
            timeout=DELIVERY_TIMEOUT_S,
        )
    except (httpx.TimeoutException, httpx.TransportError) as exc:
        return DeliveryResult(outcome="retry", body=f"{type(exc).__name__}: {exc}"[:500])

    code = resp.status_code
    body = (resp.text or "")[:2000]
    if 200 <= code < 300:
        try:
            results = (resp.json() or {}).get("results") or []
        except ValueError:
            results = []
        return DeliveryResult(
            outcome="ok", status_code=code, body=body,
            results=[r for r in results if isinstance(r, dict)],
        )
    if code in _RETRYABLE or code >= 500:
        return DeliveryResult(
            outcome="retry", status_code=code, body=body,
            retry_after=_parse_retry_after(resp.headers.get("Retry-After")),
        )
    return DeliveryResult(
        outcome="final", status_code=code, body=body,
        item_errors=_item_errors(body, len(objects)) if code == 400 else {},
    )


def batches(objects: list[dict]) -> list[list[dict]]:
    """Split into requests of ≤ MAX_BATCH_EVENTS objects and ≤ MAX_BATCH_BYTES."""
    out: list[list[dict]] = []
    cur: list[dict] = []
    size = len(b'{"events":[]}')
    for obj in objects:
        n = len(json.dumps(obj, ensure_ascii=False).encode()) + 1
        if cur and (len(cur) >= MAX_BATCH_EVENTS or size + n > MAX_BATCH_BYTES):
            out.append(cur)
            cur, size = [], len(b'{"events":[]}')
        cur.append(obj)
        size += n
    if cur:
        out.append(cur)
    return out


def check_key(config: dict) -> DeliveryResult:
    """LeadPixel key test that writes nothing: POST `{}` → 400 = key OK, 401 = bad."""
    import httpx

    try:
        resp = httpx.post(
            outbound_url(config),
            json={},
            headers={
                "Content-Type": "application/json",
                "Accept": "application/json",
                "X-API-Key": str(config.get("api_key") or ""),
            },
            timeout=DELIVERY_TIMEOUT_S,
        )
    except (httpx.TimeoutException, httpx.TransportError) as exc:
        return DeliveryResult(outcome="retry", body=f"{type(exc).__name__}: {exc}")
    return DeliveryResult(outcome="checked", status_code=resp.status_code, body=(resp.text or "")[:500])


def lead_outbound_any_enabled() -> bool:
    """Is at least one webhook source sending statuses? (health registry)."""
    from apps.leads.models import SheetSource, SheetSourceKind

    for cfg in SheetSource.objects.filter(
        kind=SheetSourceKind.WEBHOOK, active=True
    ).values_list("outbound_config", flat=True):
        if outbound_config_ready(cfg):
            return True
    return False

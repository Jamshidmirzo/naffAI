"""
Drain `LeadOutboundEvent` — report lead statuses / sales to LeadPixel
(`POST /api/crm/inbound`, see apps/leads/integrations/webhook/outbound.py).

Each tick:
  * claims due events (`select_for_update(skip_locked)` + lease) of sources
    with `outbound_config.enabled` and an `api_key` — events of other
    sources stay pending and are not attempted;
  * coalesces per lead: LeadPixel keeps «current status per lead», so only
    the latest pending snapshot of each lead is sent (it already carries
    won + amount + at from the live sale);
  * sends up to 200 objects / ≤ 256 KB per request, paced to stay under
    their 600 events/min per key;
  * 2xx → delivered (+ their per-lead result in `response_summary`);
    400/401 → final failure, no retry (a 400 that names items fails only
    those, the rest go again at once); 408/425/429/5xx/timeout → retry
    after `Retry-After`, else 60s / 2m / 10m / 1h, max MAX_ATTEMPTS.

Delivered events older than 30 days are deleted hourly.
`--once` drains what is due right now and exits.
"""

from __future__ import annotations

import logging
import time
from datetime import timedelta

from django.core.management.base import BaseCommand
from django.db import transaction
from django.db.models import Q
from django.utils import timezone

logger = logging.getLogger("leads.webhook.outbound")

MAX_ATTEMPTS = 8
LEASE = timedelta(minutes=5)
KEEP_DELIVERED = timedelta(days=30)
# 600 событий/мин на ключ у LeadPixel → не быстрее 10/с.
PACE_S_PER_EVENT = 0.1


def _claim(now, limit: int) -> list:
    from apps.leads.integrations.webhook import outbound
    from apps.leads.models import LeadOutboundEvent

    with transaction.atomic():
        events = list(
            LeadOutboundEvent.objects.select_for_update(skip_locked=True, of=("self",))
            .select_related("source")
            .filter(
                delivered_at__isnull=True,
                failed_at__isnull=True,
                source__outbound_config__enabled=True,
            )
            .filter(Q(next_try_at__isnull=True) | Q(next_try_at__lte=now))
            .order_by("id")[:limit]
        )
        events = [e for e in events if outbound.outbound_config_ready(e.source.outbound_config)]
        LeadOutboundEvent.objects.filter(pk__in=[e.pk for e in events]).update(
            next_try_at=now + LEASE
        )
    return events


def _retry_delay(attempts: int, retry_after: float | None) -> timedelta:
    from apps.leads.integrations.webhook.outbound import BACKOFF_DEFAULT

    if retry_after:
        return timedelta(seconds=retry_after)
    return BACKOFF_DEFAULT[min(max(attempts, 1) - 1, len(BACKOFF_DEFAULT) - 1)]


def process_due_outbound(*, limit: int = 1000, pace: bool = False) -> dict:
    """Claim, coalesce and deliver due events once. Returns counters."""
    from apps.common.health import record_heartbeat
    from apps.leads.integrations.webhook import outbound

    now = timezone.now()
    events = _claim(now, limit)
    stats = {"events": len(events), "sent": 0, "ok": 0, "failed": 0, "retry": 0, "gave_up": 0}

    # source → lead → [events], newest last
    by_source: dict[int, dict[int, list]] = {}
    sources = {}
    for ev in events:
        sources[ev.source_id] = ev.source
        by_source.setdefault(ev.source_id, {}).setdefault(ev.lead_id, []).append(ev)

    first_request = True
    for source_id, by_lead in by_source.items():
        config = sources[source_id].outbound_config or {}
        lead_ids = list(by_lead)
        objects = [by_lead[lid][-1].payload for lid in lead_ids]
        offset = 0
        stop_source = False
        stop_until = now
        for chunk in outbound.batches(objects):
            chunk_leads = lead_ids[offset:offset + len(chunk)]
            offset += len(chunk)
            if stop_source:
                # Сервер уже попросил подождать — остальным той же пачки
                # просто переносим срок, попытку не засчитываем.
                _postpone(by_lead, chunk_leads, stop_until)
                continue
            if pace and not first_request:
                time.sleep(PACE_S_PER_EVENT * len(chunk))
            first_request = False

            res = outbound._deliver(chunk, config)
            stats["sent"] += len(chunk)
            if res.outcome == "ok":
                _mark_delivered(by_lead, chunk_leads, res)
                stats["ok"] += len(chunk)
            elif res.outcome == "final":
                if res.item_errors:
                    bad = {chunk_leads[i]: reason for i, reason in res.item_errors.items()}
                    for lid, reason in bad.items():
                        _mark_failed(by_lead[lid], f"HTTP {res.status_code}: {reason}")
                    # Остальные объекты пачки валидны — уйдут следующим тиком.
                    _postpone(by_lead, [lid for lid in chunk_leads if lid not in bad], timezone.now())
                    stats["failed"] += len(bad)
                else:
                    for lid in chunk_leads:
                        _mark_failed(by_lead[lid], f"HTTP {res.status_code}: {res.body[:480]}")
                    stats["failed"] += len(chunk)
                logger.error(
                    "lead outbound source=%s rejected HTTP %s: %s",
                    source_id, res.status_code, res.body[:300],
                )
            else:  # retry
                attempts = 0
                for lid in chunk_leads:
                    gave_up, attempts = _mark_retry(by_lead[lid], res)
                    stats["gave_up" if gave_up else "retry"] += 1
                stop_until = timezone.now() + _retry_delay(attempts, res.retry_after)
                stop_source = res.status_code == 429 or res.retry_after is not None
                logger.warning(
                    "lead outbound source=%s retry (HTTP %s, retry_after=%s): %s",
                    source_id, res.status_code, res.retry_after, res.body[:200],
                )

    record_heartbeat("lead_outbound")
    return stats


def _event_ids(by_lead, lead_ids) -> list[int]:
    return [e.pk for lid in lead_ids for e in by_lead[lid]]


def _postpone(by_lead, lead_ids, until) -> None:
    from apps.leads.models import LeadOutboundEvent

    LeadOutboundEvent.objects.filter(pk__in=_event_ids(by_lead, lead_ids)).update(next_try_at=until)


def _mark_delivered(by_lead, lead_ids, res) -> None:
    from apps.leads.models import LeadOutboundEvent

    results = {str(r.get("id")): r for r in res.results}
    now = timezone.now()
    for lid in lead_ids:
        r = results.get(str(lid)) or {}
        summary = {
            "http": res.status_code,
            "action": r.get("action"),
            "matched": r.get("matched"),
            "status": r.get("status"),
            "at": now.isoformat(),
        }
        logger.debug("lead outbound lead=%s %s", lid, summary)
        for ev in by_lead[lid]:
            LeadOutboundEvent.objects.filter(pk=ev.pk).update(
                attempts=ev.attempts + 1,
                delivered_at=now,
                last_error="",
                response_summary=summary,
            )


def _mark_failed(events, err: str) -> None:
    from apps.leads.models import LeadOutboundEvent

    now = timezone.now()
    for ev in events:
        LeadOutboundEvent.objects.filter(pk=ev.pk).update(
            attempts=ev.attempts + 1, failed_at=now, last_error=err[:500], next_try_at=None
        )


def _mark_retry(events, res) -> tuple[bool, int]:
    from apps.leads.models import LeadOutboundEvent

    attempts = max(e.attempts for e in events) + 1
    err = f"HTTP {res.status_code}: {res.body}"[:500] if res.status_code else res.body[:500]
    if attempts >= MAX_ATTEMPTS:
        logger.error("lead outbound gave up lead=%s after %s attempts: %s", events[0].lead_id, attempts, err)
        LeadOutboundEvent.objects.filter(pk__in=[e.pk for e in events]).update(
            attempts=attempts, failed_at=timezone.now(), next_try_at=None, last_error=err
        )
        return True, attempts
    LeadOutboundEvent.objects.filter(pk__in=[e.pk for e in events]).update(
        attempts=attempts,
        next_try_at=timezone.now() + _retry_delay(attempts, res.retry_after),
        last_error=err,
    )
    return False, attempts


def cleanup_delivered() -> int:
    from apps.leads.models import LeadOutboundEvent

    deleted, _ = LeadOutboundEvent.objects.filter(
        delivered_at__lt=timezone.now() - KEEP_DELIVERED
    ).delete()
    return deleted


class Command(BaseCommand):
    help = "Deliver queued lead statuses / sales to LeadPixel (LeadOutboundEvent)."

    def add_arguments(self, parser) -> None:
        parser.add_argument("--once", action="store_true", help="Deliver due events once and exit.")
        parser.add_argument("--idle-sleep", type=float, default=5.0)

    def handle(self, *args, **opts) -> None:
        if opts["once"]:
            self.stdout.write(str(process_due_outbound()))
            return

        self.stdout.write("lead-outbound worker started")
        last_cleanup = 0.0
        while True:
            try:
                stats = process_due_outbound(pace=True)
                if stats["events"]:
                    logger.info("lead outbound batch %s", stats)
                if time.monotonic() - last_cleanup > 3600:
                    cleanup_delivered()
                    last_cleanup = time.monotonic()
            except Exception:
                logger.exception("lead-outbound tick failed")
                stats = {"events": 0, "sent": 0}
            if not stats["events"]:
                time.sleep(opts["idle_sleep"])
            elif stats["sent"]:
                # Пейсинг между тиками: 600 событий/мин на ключ.
                time.sleep(PACE_S_PER_EVENT * stats["sent"])

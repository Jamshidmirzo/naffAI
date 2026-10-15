"""
Drain `LeadOutboundEvent` — report lead statuses / sales back to webhook
sources (LeadPixel: лиды → продажи → ROAS).

Modelled on `process_sheet_writebacks`: claim due events with
`select_for_update(skip_locked)`, lease them, deliver, retry with backoff
(30s / 2m / 10m / 1h), give up after MAX_ATTEMPTS. Only sources with
`outbound_config.enabled=true` and a url are touched — events of the
others stay pending and are not attempted (LeadPixel's endpoint / format
is not known yet; `outbound._deliver` is a provisional adapter).

No docker-compose service yet and no `EXPECTED_INTERVALS` entry (see
apps/common/health.py) — add both once LeadPixel gives us the contract.

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

# Delay before attempt N+1 (index = attempts already made - 1).
BACKOFF = [
    timedelta(seconds=30),
    timedelta(minutes=2),
    timedelta(minutes=10),
    timedelta(hours=1),
]
MAX_ATTEMPTS = 8
LEASE = timedelta(minutes=5)


def process_due_outbound(*, limit: int = 50) -> dict:
    """Claim and deliver due events of enabled sources once. Returns counters."""
    from apps.common.health import record_heartbeat
    from apps.leads.integrations.webhook import outbound
    from apps.leads.models import LeadOutboundEvent

    now = timezone.now()
    with transaction.atomic():
        events = list(
            LeadOutboundEvent.objects.select_for_update(skip_locked=True, of=("self",))
            .select_related("source")
            .filter(
                delivered_at__isnull=True,
                attempts__lt=MAX_ATTEMPTS,
                source__outbound_config__enabled=True,
            )
            .filter(Q(next_try_at__isnull=True) | Q(next_try_at__lte=now))
            .order_by("id")[:limit]
        )
        events = [e for e in events if outbound.outbound_config_ready(e.source.outbound_config)]
        LeadOutboundEvent.objects.filter(pk__in=[e.pk for e in events]).update(
            next_try_at=now + LEASE
        )

    stats = {"events": len(events), "ok": 0, "failed": 0, "gave_up": 0}
    for event in events:
        try:
            outbound._deliver(event, event.source.outbound_config or {})
        except Exception as exc:
            attempts = event.attempts + 1
            err = f"{type(exc).__name__}: {exc}"[:500]
            if attempts >= MAX_ATTEMPTS:
                stats["gave_up"] += 1
                logger.error(
                    "lead outbound gave up event=%s after %s attempts: %s", event.pk, attempts, err
                )
                LeadOutboundEvent.objects.filter(pk=event.pk).update(
                    attempts=attempts, next_try_at=None, last_error=err
                )
            else:
                stats["failed"] += 1
                delay = BACKOFF[min(attempts - 1, len(BACKOFF) - 1)]
                logger.warning(
                    "lead outbound retry event=%s attempt=%s in %s: %s", event.pk, attempts, delay, err
                )
                LeadOutboundEvent.objects.filter(pk=event.pk).update(
                    attempts=attempts, next_try_at=timezone.now() + delay, last_error=err
                )
        else:
            stats["ok"] += 1
            LeadOutboundEvent.objects.filter(pk=event.pk).update(
                attempts=event.attempts + 1, delivered_at=timezone.now(), last_error=""
            )

    record_heartbeat("lead_outbound")
    return stats


class Command(BaseCommand):
    help = "Deliver queued lead statuses / sales to webhook sources (LeadOutboundEvent)."

    def add_arguments(self, parser) -> None:
        parser.add_argument("--once", action="store_true", help="Deliver due events once and exit.")
        parser.add_argument("--idle-sleep", type=float, default=5.0)

    def handle(self, *args, **opts) -> None:
        if opts["once"]:
            self.stdout.write(str(process_due_outbound()))
            return

        self.stdout.write("lead-outbound worker started")
        while True:
            try:
                stats = process_due_outbound()
                if stats["events"]:
                    logger.info("lead outbound batch %s", stats)
            except Exception:
                logger.exception("lead-outbound tick failed")
                stats = {"events": 0}
            if not stats["events"]:
                time.sleep(opts["idle_sleep"])

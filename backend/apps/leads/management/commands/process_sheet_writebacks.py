"""
Drain `SheetWritebackJob` — push lead state into Google Sheets.

Runs forever in the `sheet-writeback` docker-compose service. Each tick
claims due jobs, collapses duplicates per lead (the write always reflects
the lead's *current* state, so one write per lead is enough), writes at
~1 req/s to stay under the Sheets quota (~60 writes/min per spreadsheet)
and reschedules failures with backoff instead of dropping them.

`--once` drains what is due right now and exits (tests / manual runs).
"""

from __future__ import annotations

import logging
import time
from datetime import timedelta

from django.core.management.base import BaseCommand
from django.db import transaction
from django.utils import timezone

logger = logging.getLogger("leads.writeback")

# Delay before attempt N+1 (index = attempts already made - 1).
BACKOFF = [
    timedelta(seconds=30),
    timedelta(minutes=2),
    timedelta(minutes=10),
    timedelta(hours=1),
]
MAX_ATTEMPTS = 8


def process_due_jobs(*, limit: int = 50, pause_s: float = 1.0) -> dict:
    """Claim and process due jobs once. Returns counters."""
    from apps.common.health import record_heartbeat
    from apps.leads.models import Lead, SheetWritebackJob
    from apps.leads.services import lead_writeback_to_sheet

    now = timezone.now()
    with transaction.atomic():
        jobs = list(
            SheetWritebackJob.objects.select_for_update(skip_locked=True)
            .filter(done_at__isnull=True, next_try_at__lte=now)
            .order_by("next_try_at", "id")[:limit]
        )
        # Lease the claimed jobs so a parallel worker / crash mid-batch
        # doesn't double-write; an unfinished lease simply expires.
        SheetWritebackJob.objects.filter(pk__in=[j.pk for j in jobs]).update(
            next_try_at=now + timedelta(minutes=5)
        )

    stats = {"leads": 0, "ok": 0, "failed": 0, "gave_up": 0}
    by_lead: dict[int, list] = {}
    for job in jobs:
        by_lead.setdefault(job.lead_id, []).append(job)

    for lead_id, lead_jobs in by_lead.items():
        stats["leads"] += 1
        # Newest non-empty comment wins — matches what the last caller wanted.
        comment = next((j.comment for j in reversed(lead_jobs) if j.comment), "")
        ids = [j.pk for j in lead_jobs]
        try:
            lead = Lead.objects.select_related("sheet_source", "operator").get(pk=lead_id)
            lead_writeback_to_sheet(lead, comment=comment, raise_errors=True)
        except Lead.DoesNotExist:
            SheetWritebackJob.objects.filter(pk__in=ids).update(
                done_at=timezone.now(), last_error="lead deleted"
            )
        except Exception as exc:
            attempts = max(j.attempts for j in lead_jobs) + 1
            err = f"{type(exc).__name__}: {exc}"[:500]
            if attempts >= MAX_ATTEMPTS:
                stats["gave_up"] += 1
                logger.error(
                    "writeback gave up lead=%s after %s attempts: %s", lead_id, attempts, err
                )
                SheetWritebackJob.objects.filter(pk__in=ids).update(
                    attempts=attempts, done_at=timezone.now(), last_error=err
                )
            else:
                stats["failed"] += 1
                delay = BACKOFF[min(attempts - 1, len(BACKOFF) - 1)]
                logger.warning(
                    "writeback retry lead=%s attempt=%s in %s: %s", lead_id, attempts, delay, err
                )
                SheetWritebackJob.objects.filter(pk__in=ids).update(
                    attempts=attempts, next_try_at=timezone.now() + delay, last_error=err
                )
        else:
            stats["ok"] += 1
            SheetWritebackJob.objects.filter(pk__in=ids).update(done_at=timezone.now())
        if pause_s > 0:
            time.sleep(pause_s)

    record_heartbeat("sheet_writeback")
    return stats


class Command(BaseCommand):
    help = "Process the Google Sheets writeback queue (SheetWritebackJob)."

    def add_arguments(self, parser) -> None:
        parser.add_argument("--once", action="store_true", help="Drain due jobs once and exit.")
        parser.add_argument("--idle-sleep", type=float, default=2.0)
        parser.add_argument("--pause", type=float, default=1.0, help="Seconds between writes.")

    def handle(self, *args, **opts) -> None:
        from apps.leads.models import SheetWritebackJob

        if opts["once"]:
            self.stdout.write(str(process_due_jobs(pause_s=opts["pause"])))
            return

        self.stdout.write("sheet-writeback worker started")
        last_cleanup = 0.0
        while True:
            try:
                stats = process_due_jobs(pause_s=opts["pause"])
                if stats["leads"]:
                    logger.info("writeback batch %s", stats)
                # Keep the table small: finished jobs older than 7 days go.
                if time.monotonic() - last_cleanup > 3600:
                    SheetWritebackJob.objects.filter(
                        done_at__lt=timezone.now() - timedelta(days=7)
                    ).delete()
                    last_cleanup = time.monotonic()
            except Exception:
                logger.exception("sheet-writeback tick failed")
                stats = {"leads": 0}
            if not stats["leads"]:
                time.sleep(opts["idle_sleep"])

"""
Minutely cron: walk all enabled BotReport rows, fire the ones whose
schedule matches "now" and haven't yet run today.

Called from the `reports-scheduler` docker service loop.

Example:
    python manage.py send_scheduled_reports
    python manage.py send_scheduled_reports --report-id 3 --force
"""

from __future__ import annotations

import asyncio
import logging

from django.core.management.base import BaseCommand
from django.utils import timezone

from apps.tg_bot.models import BotReport
from apps.tg_bot.scheduler import (
    dispatch_report,
    make_bot,
    report_should_fire,
)

log = logging.getLogger(__name__)


class Command(BaseCommand):
    help = "Fire due BotReport schedules. Idempotent per (report, day)."

    def add_arguments(self, parser):
        parser.add_argument(
            "--report-id",
            type=int,
            help="Fire only this report id (still respects should_fire unless --force).",
        )
        parser.add_argument(
            "--force",
            action="store_true",
            help="Ignore schedule/idempotency checks — fire immediately.",
        )
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="Show what would be fired, don't send.",
        )

    def handle(self, *args, **opts):
        now = timezone.localtime()
        qs = BotReport.objects.filter(enabled=True)
        if opts.get("report_id"):
            qs = qs.filter(id=opts["report_id"])
        reports = list(qs)

        due = []
        for r in reports:
            if opts.get("force") or report_should_fire(r, now):
                due.append(r)

        if not due:
            self.stdout.write(f"[scheduler] {now:%H:%M} — nothing due")
            return

        self.stdout.write(f"[scheduler] {now:%H:%M} — {len(due)} report(s) due")

        if opts.get("dry_run"):
            for r in due:
                self.stdout.write(f"  would fire: #{r.id} '{r.name}' at {r.schedule_time}")
            return

        asyncio.run(_run(due))


async def _run(reports):
    bot = make_bot()
    try:
        for r in reports:
            try:
                result = await dispatch_report(bot, r, mark_sent=True)
                logging.getLogger(__name__).info(
                    "report #%s '%s': sent=%s failed=%s",
                    r.id, r.name, result["sent"], result["failed"],
                )
            except Exception:
                log.exception("dispatch failed report=%s", r.id)
    finally:
        await bot.session.close()

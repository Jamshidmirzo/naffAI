"""
Scheduler-dispatcher. The ``rop-scheduler`` docker-compose service runs this
every 60 seconds; the command decides which sub-task (briefing / pulse /
reminder / alert check / weekly / cleanup) to call based on Tashkent-local
clock. Idempotent — each sub-task guards itself via ``ROPState`` cursors or
``DailyBriefing.date`` uniqueness.

Simulation flags (``--now HH:MM --weekday 0..6``) are for local testing.
"""

from __future__ import annotations

from datetime import datetime
from zoneinfo import ZoneInfo

from django.core.management import call_command
from django.core.management.base import BaseCommand
from django.utils import timezone

TZ = ZoneInfo("Asia/Tashkent")


class Command(BaseCommand):
    help = "ROP scheduler tick (called every 60s by the rop-scheduler service)."

    def add_arguments(self, parser):
        parser.add_argument(
            "--now",
            help="Simulate HH:MM Tashkent time (e.g. --now=07:00). Bypasses real clock.",
        )
        parser.add_argument(
            "--weekday",
            type=int,
            help="Simulate weekday 0=Mon..6=Sun.",
        )
        parser.add_argument("--verbose", action="store_true")

    def handle(self, *args, **opts):
        now_real = timezone.now().astimezone(TZ)
        if opts.get("now"):
            try:
                hh, mm = (int(x) for x in opts["now"].split(":"))
            except Exception as e:
                raise SystemExit(f"bad --now format: {e}")
            now = now_real.replace(hour=hh, minute=mm, second=0, microsecond=0)
        else:
            now = now_real
        weekday = opts.get("weekday")
        if weekday is None:
            weekday = now.weekday()
        hhmm = now.strftime("%H:%M")

        verbose = opts.get("verbose")

        def _run(cmd: str, **kwargs):
            if verbose:
                self.stdout.write(f"[rop_tick] -> {cmd} {kwargs}")
            try:
                call_command(cmd, **kwargs)
            except Exception as e:
                self.stdout.write(self.style.ERROR(f"[rop_tick] {cmd} failed: {e}"))

        # Scheduled points
        if hhmm == "07:00":
            _run("rop_morning_briefing")
        elif hhmm == "14:00":
            _run("rop_midday_pulse")
        elif hhmm == "21:00":
            _run("rop_evening_wrap")
        elif hhmm in ("11:00", "15:00", "19:00"):
            _run("rop_reminder", stage=hhmm.split(":")[0])
        elif weekday == 6 and hhmm == "09:00":
            _run("rop_weekly_scorecard")

        # Every 10 minutes: alert check
        if now.minute % 10 == 0:
            _run("rop_alert_check")

        # Every 15 minutes: approval cleanup (cheap)
        if now.minute % 15 == 0:
            _run("rop_cleanup_approvals")

        if verbose:
            self.stdout.write(
                self.style.SUCCESS(f"[rop_tick] done @ {hhmm} weekday={weekday}")
            )

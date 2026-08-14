"""
Weekly cron: strip check-in / check-out photos from AttendanceLog rows
older than N days (default 30). The AttendanceLog rows themselves are
kept forever — only the ImageField file + reference are cleared. Cheap
to run, idempotent, safe on empty tables.

Usage:
    python manage.py cleanup_attendance_photos            # default 30 days
    python manage.py cleanup_attendance_photos --older-than 60
    python manage.py cleanup_attendance_photos --dry-run
"""

from __future__ import annotations

import datetime as dt
import re

from django.core.management.base import BaseCommand
from django.utils import timezone

from apps.attendance.models import AttendanceLog


def _parse_older_than(raw: str) -> int:
    """Accept `30`, `30d`, `4w`. Returns number of days."""
    s = str(raw or "30").strip().lower()
    m = re.fullmatch(r"(\d+)([dw]?)", s)
    if not m:
        raise ValueError(f"invalid --older-than value: {raw!r}")
    n = int(m.group(1))
    unit = m.group(2) or "d"
    return n * 7 if unit == "w" else n


class Command(BaseCommand):
    help = "Purge attendance photos older than N days (log rows are kept)."

    def add_arguments(self, parser) -> None:
        parser.add_argument("--older-than", default="30", help="Number of days (or Nd / Nw)")
        parser.add_argument("--dry-run", action="store_true", help="Do not delete, just report")

    def handle(self, *args, **opts) -> None:
        days = _parse_older_than(opts["older_than"])
        cutoff = timezone.now() - dt.timedelta(days=days)
        dry = bool(opts["dry_run"])

        qs = AttendanceLog.objects.filter(checked_in_at__lt=cutoff).exclude(
            checkin_photo="", checkout_photo=""
        )
        total = qs.count()
        cleared_in = 0
        cleared_out = 0

        for log in qs.iterator(chunk_size=200):
            updates: list[str] = []
            if log.checkin_photo:
                cleared_in += 1
                if not dry:
                    log.checkin_photo.delete(save=False)
                    log.checkin_photo = None
                    log.checkin_photo_phash = ""
                    updates += ["checkin_photo", "checkin_photo_phash"]
            if log.checkout_photo:
                cleared_out += 1
                if not dry:
                    log.checkout_photo.delete(save=False)
                    log.checkout_photo = None
                    log.checkout_photo_phash = ""
                    updates += ["checkout_photo", "checkout_photo_phash"]
            if updates and not dry:
                log.save(update_fields=updates)

        prefix = "[dry-run] " if dry else ""
        self.stdout.write(
            self.style.SUCCESS(
                f"{prefix}scanned {total} logs older than {days}d — "
                f"cleared checkin={cleared_in}, checkout={cleared_out} (cutoff={cutoff.isoformat()})"
            )
        )

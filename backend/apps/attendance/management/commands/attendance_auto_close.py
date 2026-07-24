import datetime as dt
from django.core.management.base import BaseCommand
from django.utils import timezone
from apps.attendance.services import auto_close_open_logs


class Command(BaseCommand):
    help = "Auto-close all unclosed operator shifts (runs daily at 23:00)"

    def add_arguments(self, parser):
        parser.add_argument(
            "--at",
            type=str,
            default=None,
            help="Datetime string to close shifts at (YYYY-MM-DDTHH:MM)",
        )
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="Dry run without modifying database",
        )

    def handle(self, *args, **options):
        at_str = options["at"]
        dry_run = options["dry_run"]

        if at_str:
            target_time = timezone.make_aware(dt.datetime.strptime(at_str, "%Y-%m-%dT%H:%M"))
        else:
            target_time = timezone.now()

        if dry_run:
            from apps.attendance.models import AttendanceLog

            count = AttendanceLog.objects.filter(checked_out_at__isnull=True).count()
            self.stdout.write(f"[Dry Run] Would close {count} shifts at {target_time}")
            return

        count = auto_close_open_logs(at=target_time)
        self.stdout.write(
            self.style.SUCCESS(f"Successfully auto-closed {count} shifts at {target_time}")
        )

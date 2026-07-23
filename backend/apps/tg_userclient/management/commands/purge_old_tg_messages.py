"""
Management command: purge TG messages older than retention period.

Usage:
    python manage.py purge_old_tg_messages

Cron: ``0 4 * * *`` (daily at 4 AM).
TgAiInsight records are kept longer — they're aggregated and contain
less personal data.
"""

from datetime import timedelta

from django.conf import settings
from django.core.management.base import BaseCommand
from django.utils import timezone


class Command(BaseCommand):
    help = "Delete TG messages older than TG_MESSAGE_RETENTION_DAYS"

    def add_arguments(self, parser):
        parser.add_argument(
            "--days",
            type=int,
            default=None,
            help="Override retention days (default: settings.TG_MESSAGE_RETENTION_DAYS)",
        )
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="Only print how many messages would be deleted",
        )

    def handle(self, *args, **options):
        from apps.tg_userclient.models import TgMessage

        days = options["days"] or getattr(settings, "TG_MESSAGE_RETENTION_DAYS", 90)
        cutoff = timezone.now() - timedelta(days=days)

        qs = TgMessage.objects.filter(sent_at__lt=cutoff)
        count = qs.count()

        if options["dry_run"]:
            self.stdout.write(
                f"[DRY RUN] Would delete {count} messages older than {days} days"
            )
            return

        total_deleted = 0
        batch_size = 10_000
        while True:
            ids = list(
                TgMessage.objects.filter(sent_at__lt=cutoff)
                .values_list("id", flat=True)[:batch_size]
            )
            if not ids:
                break
            deleted, _ = TgMessage.objects.filter(id__in=ids).delete()
            total_deleted += deleted
            self.stdout.write(f"batch: {deleted}, total: {total_deleted}")

        self.stdout.write(
            self.style.SUCCESS(f"Deleted {total_deleted} messages older than {days} days")
        )

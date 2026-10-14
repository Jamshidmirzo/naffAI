from django.core.management.base import BaseCommand

from apps.rop_agent.services import run_alert_check


class Command(BaseCommand):
    help = "Run all ROP alert triggers; push new ones to the owner on Telegram."

    def add_arguments(self, parser):
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="Run checks but don't persist and don't push to Telegram.",
        )

    def handle(self, *args, **opts):
        result = run_alert_check(dry_run=opts["dry_run"])
        self.stdout.write(self.style.SUCCESS(repr(result)))

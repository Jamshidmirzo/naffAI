from django.core.management.base import BaseCommand

from apps.rop_agent.services import run_morning_briefing


class Command(BaseCommand):
    help = "Run the ROP agent morning briefing (07:00 Tashkent)."

    def add_arguments(self, parser):
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="Build the briefing but don't push to Telegram or persist.",
        )

    def handle(self, *args, **opts):
        result = run_morning_briefing(dry_run=opts["dry_run"])
        self.stdout.write(self.style.SUCCESS(repr(result)))

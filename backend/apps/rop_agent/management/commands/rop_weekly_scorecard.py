from django.core.management.base import BaseCommand

from apps.rop_agent.services import run_weekly_scorecard


class Command(BaseCommand):
    help = "Run the ROP weekly scorecard (Sun 09:00 Tashkent)."

    def add_arguments(self, parser):
        parser.add_argument("--dry-run", action="store_true")

    def handle(self, *args, **opts):
        result = run_weekly_scorecard(dry_run=opts["dry_run"])
        self.stdout.write(self.style.SUCCESS(repr(result)))

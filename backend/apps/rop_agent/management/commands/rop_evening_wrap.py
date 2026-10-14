from django.core.management.base import BaseCommand

from apps.rop_agent.services import run_evening_wrap


class Command(BaseCommand):
    help = "Run the ROP agent evening wrap (21:00 Tashkent)."

    def add_arguments(self, parser):
        parser.add_argument("--dry-run", action="store_true")

    def handle(self, *args, **opts):
        result = run_evening_wrap(dry_run=opts["dry_run"])
        self.stdout.write(self.style.SUCCESS(repr(result)))

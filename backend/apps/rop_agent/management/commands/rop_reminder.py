from django.core.management.base import BaseCommand

from apps.rop_agent.services import run_reminder


class Command(BaseCommand):
    help = "Run a ROP agent reminder pulse (11 / 15 / 19 Tashkent)."

    def add_arguments(self, parser):
        parser.add_argument(
            "--stage",
            required=True,
            choices=["11", "15", "19"],
            help="Which pulse to run.",
        )
        parser.add_argument("--dry-run", action="store_true")

    def handle(self, *args, **opts):
        result = run_reminder(opts["stage"], dry_run=opts["dry_run"])
        self.stdout.write(self.style.SUCCESS(repr(result)))

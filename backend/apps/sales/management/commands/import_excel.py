from django.core.management.base import BaseCommand, CommandError

from apps.sales.imports.excel_importer import import_xlsx


class Command(BaseCommand):
    help = "Import the shop's «savdo» Excel workbook into Sales/Operators/Channels."

    def add_arguments(self, parser):
        parser.add_argument("--file", required=True, help="Path to .xlsx file")
        parser.add_argument(
            "--wipe",
            action="store_true",
            help="Delete all existing Sales before importing (use for fresh load).",
        )

    def handle(self, *args, **opts):
        path = opts["file"]
        try:
            result = import_xlsx(path, wipe_existing=opts["wipe"])
        except FileNotFoundError as exc:
            raise CommandError(str(exc)) from exc

        self.stdout.write(self.style.SUCCESS(f"Sales created: {result.sales_created}"))
        self.stdout.write(f"Sales skipped (already existed): {result.sales_skipped}")
        self.stdout.write(f"Operators created: {result.operators_created}")
        self.stdout.write(f"Channels created: {result.channels_created}")
        if result.errors:
            self.stdout.write(self.style.WARNING("Notes:"))
            for e in result.errors:
                self.stdout.write(f"  - {e}")

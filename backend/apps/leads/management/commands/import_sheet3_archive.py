"""
One-shot import of Sheet 3 (Bitrix historical dump) as archived leads.

Every row is inserted with `status=archived`, `bitrix_*` fields copied to
`Lead.metadata`. Skips duplicates by the standard (sheet_source, row_index)
constraint — safe to re-run.
"""

from __future__ import annotations

from django.core.management.base import BaseCommand, CommandError

from apps.leads.integrations.google_sheets.client import (
    GoogleSheetsClient,
    GoogleSheetsUnavailable,
)
from apps.leads.integrations.google_sheets.sync import sync_one
from apps.leads.models import SheetSource


class Command(BaseCommand):
    help = "One-shot import of the Bitrix archive worksheet (gid=1712070933) as archived leads."

    def add_arguments(self, parser) -> None:
        parser.add_argument(
            "--gid",
            type=int,
            default=1712070933,
            help="Google Sheet tab gid to import (default = sheet 3 gid).",
        )

    def handle(self, *args, **opts) -> None:
        gid = int(opts["gid"])
        src = SheetSource.objects.filter(gid=gid).first()
        if src is None:
            raise CommandError(
                f"No SheetSource with gid={gid}. Run bootstrap_lead_domain first."
            )
        try:
            client = GoogleSheetsClient()
        except GoogleSheetsUnavailable as exc:
            raise CommandError(str(exc)) from exc

        result = sync_one(client=client, sheet_source=src, force_full_scan=True)
        self.stdout.write(
            self.style.SUCCESS(
                f"read={result.read} imported={result.imported} "
                f"skipped={result.skipped} errors={result.errors} max_row={result.max_row}"
            )
        )

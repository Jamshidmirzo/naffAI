"""
Pull new rows from every active `SheetSource` and materialise them as leads.

Meant to run from cron every minute. Idempotent — safe to re-run.

    * * * * * cd /opt/naffAI && ./venv/bin/python manage.py sync_sheets_leads >> /var/log/naff/sync.log 2>&1
"""

from __future__ import annotations

from django.core.management.base import BaseCommand

from apps.leads.integrations.google_sheets.sync import sync_all


class Command(BaseCommand):
    help = "Sync new rows from Google Sheets into Leads (idempotent)."

    def add_arguments(self, parser) -> None:
        parser.add_argument(
            "--full",
            action="store_true",
            help="Ignore watermarks and re-scan every configured sheet.",
        )

    def handle(self, *args, **opts) -> None:
        results = sync_all(force_full_scan=bool(opts.get("full")))
        for r in results:
            self.stdout.write(
                self.style.SUCCESS(
                    f"[sheet#{r.sheet_source_id}] read={r.read} "
                    f"imported={r.imported} skipped={r.skipped} "
                    f"errors={r.errors} max_row={r.max_row}"
                )
            )
        if not results:
            self.stdout.write(
                self.style.WARNING(
                    "No active SheetSource rows (or credentials missing) — nothing to do."
                )
            )

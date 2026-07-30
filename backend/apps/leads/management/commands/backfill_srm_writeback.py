"""
One-off: recover the srm sheet rows that the old writeback (fixed D/E/F/G)
wrote status into, and salvage phone_alt from rows that are still intact.

Idempotent — safe to re-run.
"""

from __future__ import annotations

from django.core.management.base import BaseCommand
from django.db import transaction

from apps.common.validators import normalize_uz_phone
from apps.leads.models import Lead, SheetSource
from apps.leads.services import lead_writeback_to_sheet


class Command(BaseCommand):
    help = "Backfill srm sheet: restore phone / phone_alt + move writeback to F/G/H/I."

    def add_arguments(self, parser):
        parser.add_argument(
            "--sheet-name",
            default="srm",
            help="SheetSource.name (default: srm).",
        )
        parser.add_argument(
            "--from-row",
            type=int,
            default=91,
            help="First 1-based sheet row that lives in the new (5-column) format.",
        )

    def handle(self, *args, sheet_name: str, from_row: int, **opts):
        from apps.leads.integrations.google_sheets.client import (
            GoogleSheetsClient,
            GoogleSheetsUnavailable,
        )

        try:
            src = SheetSource.objects.get(name=sheet_name)
        except SheetSource.DoesNotExist:
            self.stderr.write(f"SheetSource '{sheet_name}' not found")
            return

        try:
            client = GoogleSheetsClient()
        except GoogleSheetsUnavailable as e:
            self.stderr.write(f"Google Sheets unavailable: {e}")
            return

        ws = src.worksheet_name or client.worksheet_name_by_gid(src.spreadsheet_id, src.gid)
        if not ws:
            self.stderr.write("cannot resolve worksheet name")
            return
        safe = ws.replace("'", "''")

        leads = list(
            Lead.objects.filter(
                sheet_source=src, sheet_row_index__gte=from_row
            ).order_by("sheet_row_index")
        )
        self.stdout.write(f"scanning {len(leads)} leads from row {from_row} of '{ws}'")

        for lead in leads:
            row_idx = lead.sheet_row_index
            rng = f"'{safe}'!A{row_idx}:I{row_idx}"
            try:
                raw = client.raw_values(src.spreadsheet_id, rng)
            except Exception as exc:
                self.stderr.write(f"  row {row_idx}: read failed: {exc}")
                continue
            cells = raw[0] if raw else []
            # Pad to 9 cells so we can index safely.
            cells = list(cells) + [""] * (9 - len(cells))
            col_d, col_e = (cells[3] or "").strip(), (cells[4] or "").strip()

            e_norm, e_valid = normalize_uz_phone(col_e)
            d_norm, d_valid = normalize_uz_phone(col_d)

            # Case A — E still holds the phone → row is untouched. Try to
            # salvage phone_alt from D.
            broken = not (e_valid and e_norm == lead.phone)
            phone_alt_new = ""
            if not broken and d_valid and d_norm != lead.phone:
                phone_alt_new = d_norm

            fields_to_update: list[str] = []
            if phone_alt_new and phone_alt_new != lead.phone_alt:
                lead.phone_alt = phone_alt_new
                fields_to_update.append("phone_alt")

            # Pin writeback to F/G/H/I for all new-format rows.
            meta = dict(lead.metadata or {})
            if meta.get("writeback_start_col") != "F":
                meta["writeback_start_col"] = "F"
                lead.metadata = meta
                fields_to_update.append("metadata")

            if fields_to_update:
                with transaction.atomic():
                    Lead.objects.filter(pk=lead.pk).update(
                        **{f: getattr(lead, f) for f in fields_to_update}
                    )

            # Restore D/E in the sheet if broken. D stays empty (second
            # phone was lost when the old writeback overwrote it); E gets
            # the normalized phone back from the DB.
            if broken:
                try:
                    client.update_cells(
                        src.spreadsheet_id,
                        f"'{safe}'!D{row_idx}:E{row_idx}",
                        [["", lead.phone]],
                    )
                    self.stdout.write(
                        f"  row {row_idx}: restored phone={lead.phone}"
                    )
                except Exception as exc:
                    self.stderr.write(f"  row {row_idx}: D/E restore failed: {exc}")

            # (Re-)write STATUS/OPERATOR/UPDATED/COMMENT into F/G/H/I.
            try:
                lead_writeback_to_sheet(
                    lead, comment="backfill after format shift"
                )
            except Exception as exc:
                self.stderr.write(f"  row {row_idx}: writeback failed: {exc}")

            marker = "BROKEN→fixed" if broken else "ok"
            alt_note = f" +alt={phone_alt_new}" if phone_alt_new else ""
            self.stdout.write(f"  row {row_idx} {marker}{alt_note}")

        self.stdout.write(self.style.SUCCESS("done"))

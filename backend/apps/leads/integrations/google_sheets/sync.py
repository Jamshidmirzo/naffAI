"""
End-to-end sync of Google Sheets rows into `Lead` records.

Idempotent by `(sheet_source, row_index)`. Safe to run every minute.

For each `SheetSource(active=True)`:
  1. Fetch the whole worksheet via `GoogleSheetsClient.get_rows`.
  2. For every row whose sheet index > `sheet_source.last_synced_row`:
       - call `lead_create_from_sheet_row` (idempotent per row-key)
  3. Bump the watermark to the highest processed row index.

`lead_create_from_sheet_row` handles alias resolution, phone normalization,
auto-assignment, and needs-review escalation — this module stays as a
thin orchestration layer.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

from django.db import transaction
from django.utils import timezone

from apps.leads.models import SheetSource
from apps.leads.services import (
    lead_create_from_sheet_row,
    sheet_source_bump_watermark,
)

from .client import GoogleSheetsClient, GoogleSheetsUnavailable

logger = logging.getLogger("leads.google_sheets.sync")


@dataclass
class SyncResult:
    sheet_source_id: int
    read: int
    imported: int
    skipped: int
    errors: int
    max_row: int


def sync_one(
    *,
    client: GoogleSheetsClient,
    sheet_source: SheetSource,
    force_full_scan: bool = False,
) -> SyncResult:
    worksheet_name = sheet_source.worksheet_name
    if not worksheet_name:
        worksheet_name = (
            client.worksheet_name_by_gid(sheet_source.spreadsheet_id, sheet_source.gid)
            or ""
        )
    if not worksheet_name:
        logger.warning(
            "No worksheet found for spreadsheet=%s gid=%s",
            sheet_source.spreadsheet_id,
            sheet_source.gid,
        )
        return SyncResult(sheet_source.id, 0, 0, 0, 1, sheet_source.last_synced_row)

    rows = client.get_rows(sheet_source.spreadsheet_id, worksheet_name)
    read = len(rows)
    imported = 0
    skipped = 0
    errors = 0
    max_row = sheet_source.last_synced_row

    watermark = 0 if force_full_scan else sheet_source.last_synced_row

    for row in rows:
        row_index = int(row.get("__row__") or 0)
        if row_index <= watermark:
            skipped += 1
            if row_index > max_row:
                max_row = row_index
            continue
        try:
            with transaction.atomic():
                lead = lead_create_from_sheet_row(
                    sheet_source=sheet_source, row_index=row_index, raw_row=row
                )
                if lead is not None:
                    imported += 1
        except Exception:
            logger.exception(
                "sheet_source=%s row=%s failed to import",
                sheet_source.id,
                row_index,
            )
            errors += 1
        if row_index > max_row:
            max_row = row_index

    if max_row > sheet_source.last_synced_row:
        sheet_source_bump_watermark(
            sheet_source=sheet_source, last_row=max_row, synced_at=timezone.now()
        )

    return SyncResult(
        sheet_source.id,
        read=read,
        imported=imported,
        skipped=skipped,
        errors=errors,
        max_row=max_row,
    )


def sync_all(*, force_full_scan: bool = False) -> list[SyncResult]:
    try:
        client = GoogleSheetsClient()
    except GoogleSheetsUnavailable as exc:
        logger.warning("Google Sheets sync skipped: %s", exc)
        return []

    results: list[SyncResult] = []
    for src in SheetSource.objects.filter(active=True).order_by("id"):
        try:
            r = sync_one(client=client, sheet_source=src, force_full_scan=force_full_scan)
            results.append(r)
            logger.info(
                "sheet_source=%s read=%s imported=%s skipped=%s errors=%s max_row=%s",
                src.id,
                r.read,
                r.imported,
                r.skipped,
                r.errors,
                r.max_row,
            )
        except Exception:
            logger.exception("sheet_source=%s sync run failed", src.id)
            results.append(
                SyncResult(
                    src.id,
                    read=0,
                    imported=0,
                    skipped=0,
                    errors=1,
                    max_row=src.last_synced_row,
                )
            )
    return results

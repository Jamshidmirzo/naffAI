"""
Reconcile every active Google sheet against Lead.status and enqueue
writebacks for rows that drifted.

Successor of `writeback_reconcile_srm`, which only looked at the `srm`
sheet — that source was retired on 2026-10-07 (`srm_deprecated`), so the
nightly safety net silently stopped covering the live sheets. This one
walks all `SheetSource(active=True)`, reads each status cell at the
column the lead actually writes to (`metadata.writeback_start_col`), and
queues a `SheetWritebackJob` for every EMPTY / MISMATCH row. Writing is
left to the `sheet-writeback` worker (retries + quota pacing).

Skipped on purpose: `new` / `needs_review` leads and leads without an
operator — nothing has been written for them yet, so an empty cell is
expected. No Telegram notification.
"""

from __future__ import annotations

from datetime import timedelta

from django.core.management.base import BaseCommand
from django.utils import timezone


def _last9(value) -> str:
    digits = "".join(ch for ch in str(value or "") if ch.isdigit())
    return digits[-9:] if len(digits) >= 9 else ""


def row_belongs_to(row: list, phone: str) -> bool:
    """True if some cell of the sheet row carries the lead's phone.

    Guards against rows that were sorted / inserted after import: then
    `sheet_row_index` points at somebody else and a rewrite would clobber
    a foreign row.
    """
    want = _last9(phone)
    return bool(want) and any(_last9(cell) == want for cell in row)


def status_matches(cell: str, status: str, label_ru: str, label_uz: str) -> bool:
    """Same fuzzy rule as writeback_reconcile_srm: code or either label."""
    v = (cell or "").strip().lower()
    if not v:
        return False
    st = status.lower()
    ru = (label_ru or "").strip().lower()
    uz = (label_uz or "").strip().lower()
    return (
        st in v or v in st or bool(ru and (ru in v or v in ru)) or bool(uz and (uz in v or v in uz))
    )


class Command(BaseCommand):
    help = "Compare active sheets with Lead.status and enqueue writebacks for drift."

    def add_arguments(self, parser) -> None:
        parser.add_argument("--days", type=int, default=3, help="Leads updated in the last N days.")
        parser.add_argument("--dry-run", action="store_true", help="Only report, enqueue nothing.")

    def handle(self, *args, **opts) -> None:
        from apps.common.health import record_heartbeat
        from apps.leads.integrations.google_sheets.client import GoogleSheetsClient
        from apps.leads.models import Lead, LeadStatus, LeadStatusLabel, SheetSource
        from apps.leads.services import (
            _col_to_idx,
            _writeback_batch_async,
            _writeback_config,
        )

        cutoff = timezone.now() - timedelta(days=int(opts["days"]))
        dry = bool(opts["dry_run"])
        labels = {
            s.code: (s.label_ru or "", s.label_uz or "") for s in LeadStatusLabel.objects.all()
        }
        client = GoogleSheetsClient()
        total_checked = total_drift = 0

        for src in SheetSource.objects.filter(active=True).order_by("id"):
            cfg = _writeback_config(src)
            if not cfg.get("enabled", True):
                continue
            leads = list(
                Lead.objects.filter(
                    sheet_source=src,
                    updated_at__gte=cutoff,
                    operator__isnull=False,
                    sheet_row_index__isnull=False,
                ).exclude(status__in=[LeadStatus.NEW, LeadStatus.NEEDS_REVIEW])
            )
            if not leads:
                continue
            tab = src.worksheet_name or client.worksheet_name_by_gid(src.spreadsheet_id, src.gid)
            if not tab:
                self.stderr.write(f"[{src.id}] {src.name}: cannot resolve worksheet")
                continue
            safe = tab.replace("'", "''")
            max_row = max(lead.sheet_row_index for lead in leads)
            try:
                rows = client.raw_values(src.spreadsheet_id, f"'{safe}'!A1:Z{max_row}")
            except Exception as exc:
                self.stderr.write(f"[{src.id}] {src.name}: read failed: {exc}")
                continue

            drift: list[int] = []
            moved: list[int] = []
            for lead in leads:
                start = (lead.metadata or {}).get("writeback_start_col") or cfg["status_col"]
                col = _col_to_idx(start) - 1
                row = rows[lead.sheet_row_index - 1] if lead.sheet_row_index - 1 < len(rows) else []
                if not row_belongs_to(row, lead.phone):
                    moved.append(lead.id)
                    continue
                cell = str(row[col]) if col < len(row) and row[col] is not None else ""
                ru, uz = labels.get(lead.status, ("", ""))
                if not status_matches(cell, lead.status, ru, uz):
                    drift.append(lead.id)

            total_checked += len(leads)
            total_drift += len(drift)
            self.stdout.write(
                f"[{src.id}] {src.name}: checked={len(leads)} drift={len(drift)} "
                f"row_moved={len(moved)} {drift[:10]}"
            )
            if drift and not dry:
                _writeback_batch_async(drift, comment="")

        self.stdout.write(
            f"DONE checked={total_checked} drift={total_drift}{' (dry-run)' if dry else ' enqueued'}"
        )
        if not dry:
            record_heartbeat("writeback_reconcile")

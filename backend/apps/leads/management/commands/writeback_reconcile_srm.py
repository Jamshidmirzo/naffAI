"""
Nightly reconciliation of srm sheet writeback: reads the entire D column
from the srm Google Sheet, compares with Lead.status for every lead
updated in the last 30 days, and re-fires `lead_writeback_to_sheet` for
any mismatch or empty cell.

Payroll is calculated from the sheet contents, so even 4% drift (as
observed in the 2026-10-07 audit) directly skews operator pay. This task
is the belt-and-suspenders backup to the inline writeback path and the
retry-wrapper on the HTTP PUT.

Default schedule — once per night at 22:00 UTC (03:00 Tashkent), driven
by the `writeback-reconcile` docker-compose service.
"""

from __future__ import annotations

import time
from datetime import timedelta

import httpx
from django.core.management.base import BaseCommand
from django.utils import timezone


class Command(BaseCommand):
    help = (
        "Reconcile srm sheet D column against Lead.status. "
        "Re-fire writeback for empties / mismatches."
    )

    def add_arguments(self, parser) -> None:
        parser.add_argument(
            "--days",
            type=int,
            default=30,
            help="How many days back to audit (default 30).",
        )
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="Only report counts, don't rewrite anything.",
        )
        parser.add_argument(
            "--sleep",
            type=float,
            default=1.0,
            help="Seconds between writes (throttle to avoid 429). Default 1.0.",
        )

    def handle(self, *args, **opts) -> None:
        from apps.leads.integrations.google_sheets.client import GoogleSheetsClient
        from apps.leads.models import Lead, LeadStatusLabel, SheetSource
        from apps.leads.services import lead_writeback_to_sheet

        days = int(opts["days"])
        dry = bool(opts["dry_run"])
        sleep_s = float(opts["sleep"])

        srm = SheetSource.objects.filter(name__iexact="srm", active=True).first()
        if srm is None:
            self.stdout.write(self.style.WARNING("No active srm sheet, skipping."))
            return

        client = GoogleSheetsClient()
        tab = srm.worksheet_name or "srm"
        self.stdout.write(f"Reading D column from srm sheet (tab={tab!r})...")
        try:
            rows = client.raw_values(srm.spreadsheet_id, f"'{tab}'!D1:D30000")
        except httpx.HTTPError as e:
            self.stderr.write(self.style.ERROR(f"Sheet read failed: {e}"))
            return
        sheet_d = {}
        for i, r in enumerate(rows, start=1):
            sheet_d[i] = (r[0] if r else "").strip()
        self.stdout.write(f"Read {len(sheet_d)} rows.")

        cutoff = timezone.now() - timedelta(days=days)
        leads = list(
            Lead.objects.filter(sheet_source=srm, updated_at__gte=cutoff)
            .exclude(sheet_row_index__isnull=True)
            .exclude(status="new")
            .order_by("-updated_at")
        )
        self.stdout.write(f"Candidate leads (updated last {days}d): {len(leads)}")

        labels = {}
        for s in LeadStatusLabel.objects.all():
            labels[s.code] = {
                "ru": (s.label_ru or "").strip(),
                "uz": (s.label_uz or "").strip(),
            }

        problematic = []
        for l in leads:
            sd = sheet_d.get(l.sheet_row_index, "")
            if not sd:
                problematic.append((l, "EMPTY"))
                continue
            lab = labels.get(l.status, {})
            sd_l = sd.lower()
            status_l = l.status.lower()
            ru_l = lab.get("ru", "").lower()
            uz_l = lab.get("uz", "").lower()
            if (
                status_l in sd_l
                or sd_l in status_l
                or (ru_l and (ru_l == sd_l or ru_l in sd_l or sd_l in ru_l))
                or (uz_l and (uz_l == sd_l or uz_l in sd_l or sd_l in uz_l))
            ):
                continue
            problematic.append((l, "MISMATCH"))

        empty_n = sum(1 for _, r in problematic if r == "EMPTY")
        miss_n = sum(1 for _, r in problematic if r == "MISMATCH")
        self.stdout.write(
            f"Discrepancies: EMPTY={empty_n} MISMATCH={miss_n} total={len(problematic)}"
        )

        if dry:
            for l, reason in problematic[:20]:
                self.stdout.write(
                    f"  [{reason}] lead={l.id} row={l.sheet_row_index} status={l.status}"
                )
            return

        ok = fail = 0
        for i, (lead, _reason) in enumerate(problematic, start=1):
            try:
                lead_writeback_to_sheet(lead=lead, comment="nightly-reconcile")
                ok += 1
            except Exception as e:  # noqa: BLE001
                fail += 1
                self.stderr.write(f"  lead={lead.id} failed: {e}")
            if i % 50 == 0:
                self.stdout.write(f"  …{i}/{len(problematic)} ok={ok} fail={fail}")
            time.sleep(sleep_s)
        self.stdout.write(
            self.style.SUCCESS(
                f"DONE total={len(problematic)} ok={ok} fail={fail}"
            )
        )

        # Notify owner via TG so he sees the drift trend.
        try:
            from django.conf import settings
            token = getattr(settings, "TELEGRAM_BOT_TOKEN", "")
            if token:
                text = (
                    f"🧮 <b>Writeback reconcile</b> ({days}д): проверено {len(leads)}, "
                    f"исправлено {ok}/{len(problematic)} (empty={empty_n}, "
                    f"mismatch={miss_n}){', fail=' + str(fail) if fail else ''}"
                )
                httpx.post(
                    f"https://api.telegram.org/bot{token}/sendMessage",
                    json={
                        "chat_id": 88938071,
                        "text": text,
                        "parse_mode": "HTML",
                    },
                    timeout=10.0,
                )
        except Exception:  # noqa: BLE001
            pass

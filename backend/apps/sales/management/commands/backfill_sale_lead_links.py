"""
One-shot backfill: link historical Sales without lead_id to matching Leads
by client_phone, and flip non-terminal matched leads to WON.

Idempotent — safe to re-run:
  - Sales that already have lead_id are skipped up front (queryset filter).
  - Leads already in a terminal status are counted separately (skipped_terminal)
    and NOT re-flipped — mirrors the invariant in `_link_sale_to_lead_and_mark_won`.

Usage:
  python manage.py backfill_sale_lead_links --dry-run   # report only, no writes
  python manage.py backfill_sale_lead_links             # apply

Why we need this: on prod ~273/278 confirmed sales were created without a
lead_id (dostik enters sales manually via the dashboard), so the
"operator conversion" metric on /leads-stats reads ~0% even for operators
who close deals. Auto-match on sale_create fixes new sales going forward;
this command backfills the historical ones.
"""

from __future__ import annotations

from django.core.management.base import BaseCommand
from django.db import transaction

from apps.sales.services import _find_lead_by_client_phone


class Command(BaseCommand):
    help = (
        "Backfill Sale.lead_id + flip matched non-terminal Leads to WON "
        "for historical sales that were created without a lead link."
    )

    def add_arguments(self, parser):
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="Report matches without writing anything.",
        )
        parser.add_argument(
            "--limit",
            type=int,
            default=0,
            help="Cap the number of sales processed (0 = no limit).",
        )
        parser.add_argument(
            "--verbose-matches",
            action="store_true",
            help="Print one line per matched sale.",
        )

    def handle(self, *args, **opts):
        from apps.leads.models import LeadStatus
        from apps.leads.selectors import terminal_lead_status_codes
        from apps.leads.services import lead_update_status
        from apps.sales.models import Sale

        dry = bool(opts["dry_run"])
        limit = int(opts["limit"] or 0)
        verbose = bool(opts["verbose_matches"])

        terminal = set(terminal_lead_status_codes())

        qs = (
            Sale.objects.filter(lead_id__isnull=True, is_deleted=False)
            .exclude(client_phone__in=["", None])
            .order_by("id")
        )
        if limit > 0:
            qs = qs[:limit]

        processed = 0
        matched = 0
        marked_won = 0
        skipped_terminal = 0
        errors = 0

        mode = "DRY-RUN" if dry else "COMMIT"
        self.stdout.write(self.style.NOTICE(f"[{mode}] scanning sales without lead_id…"))

        for sale in qs.iterator(chunk_size=200):
            processed += 1
            try:
                lead = _find_lead_by_client_phone(sale.client_phone)
                if lead is None:
                    continue
                matched += 1
                old_status = lead.status
                will_flip = old_status not in terminal

                if verbose:
                    marker = "→ won" if will_flip else "(terminal, keep)"
                    self.stdout.write(
                        f"  sale_id={sale.id} phone={sale.client_phone} "
                        f"lead_id={lead.id} old_status={old_status} {marker}"
                    )

                if dry:
                    if will_flip:
                        marked_won += 1
                    else:
                        skipped_terminal += 1
                    continue

                with transaction.atomic():
                    # Re-read under FOR UPDATE to avoid races with concurrent
                    # sale_create / lead_update_status.
                    from apps.leads.models import Lead

                    lead_locked = (
                        Lead.objects.select_for_update().filter(pk=lead.id).first()
                    )
                    if lead_locked is None:
                        continue
                    sale.lead_id = lead_locked.id
                    update_fields = ["lead"]
                    if lead_locked.sheet_source_id and not sale.sheet_source_id:
                        sale.sheet_source_id = lead_locked.sheet_source_id
                        update_fields.append("sheet_source")
                    sale.save(update_fields=update_fields)

                    if lead_locked.status not in terminal:
                        lead_update_status(
                            lead=lead_locked,
                            status=LeadStatus.WON,
                            user=None,
                            comment=(
                                f"Backfill: продажа №{sale.id} — "
                                f"phone-match с историческим лидом."
                            ),
                        )
                        marked_won += 1
                    else:
                        skipped_terminal += 1
            except Exception as exc:
                errors += 1
                self.stderr.write(
                    self.style.ERROR(
                        f"  ERROR sale_id={sale.id}: {exc!r}"
                    )
                )

        self.stdout.write("")
        self.stdout.write(
            self.style.SUCCESS(
                f"[{mode}] done: processed={processed} matched={matched} "
                f"marked_won={marked_won} skipped_terminal={skipped_terminal} "
                f"errors={errors}"
            )
        )
        if dry:
            self.stdout.write(
                self.style.WARNING(
                    "Nothing was written. Re-run without --dry-run to apply."
                )
            )

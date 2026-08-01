"""
Release leads that have been sitting on an operator's plate untouched
for too long. Default threshold: 10 days.

Untouched = still in an active non-terminal status AND updated_at is
older than the cutoff. Postponed leads are left alone (operator asked
for delay deliberately).

Idempotent — safe to run daily.
"""

from __future__ import annotations

import datetime as dt

from django.core.management.base import BaseCommand
from django.db import transaction
from django.utils import timezone

from apps.leads.models import Lead, LeadAssignment, LeadStatus
from apps.leads.selectors import active_lead_status_codes, terminal_lead_status_codes


class Command(BaseCommand):
    help = "Release leads untouched by their operator for N days back to the RR pool."

    def add_arguments(self, parser):
        parser.add_argument("--days", type=int, default=10)
        parser.add_argument("--dry-run", action="store_true")

    def handle(self, *args, **opts):
        days = int(opts["days"])
        cutoff = timezone.now() - dt.timedelta(days=days)
        workable = list(set(active_lead_status_codes()) - set(terminal_lead_status_codes()))
        qs = Lead.objects.filter(
            operator__isnull=False,
            status__in=workable,
            postponed_at__isnull=True,
            updated_at__lt=cutoff,
        )
        count = qs.count()
        self.stdout.write(f"stale (>{days}d, active-non-terminal): {count}")
        if opts["dry_run"]:
            return

        with transaction.atomic():
            # Deactivate any active LeadAssignment on these leads so history
            # stays coherent — the next RR pass creates fresh assignments.
            LeadAssignment.objects.filter(
                lead__in=qs, active=True
            ).update(active=False)
            qs.update(
                operator=None,
                status=LeadStatus.NEW,
                updated_at=timezone.now(),
            )
        self.stdout.write(self.style.SUCCESS(f"released {count} leads"))

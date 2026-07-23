"""
Weekly (or ad-hoc) marketing analyst run.

Usage:
    python manage.py run_marketing_analyst
    python manage.py run_marketing_analyst --days 30
    python manage.py run_marketing_analyst --start 2026-06-01 --end 2026-06-30
"""

from __future__ import annotations

import datetime as dt

from django.core.management.base import BaseCommand, CommandError
from django.utils import timezone

from apps.marketing.services import generate_marketing_insight


class Command(BaseCommand):
    help = "Generate marketing insight (LLM) for a period."

    def add_arguments(self, parser):
        parser.add_argument("--days", type=int, default=7, help="Days back from today (default: 7).")
        parser.add_argument("--start", type=str, default="", help="Explicit start date YYYY-MM-DD.")
        parser.add_argument("--end", type=str, default="", help="Explicit end date YYYY-MM-DD.")

    def handle(self, *args, **opts):
        if opts["start"] and opts["end"]:
            try:
                start = dt.date.fromisoformat(opts["start"])
                end = dt.date.fromisoformat(opts["end"])
            except ValueError as exc:
                raise CommandError(f"Bad date format: {exc}") from exc
        else:
            end = timezone.localdate()
            start = end - dt.timedelta(days=opts["days"] - 1)

        self.stdout.write(f"Running marketing analyst for {start} .. {end}")
        insight = generate_marketing_insight(period_start=start, period_end=end)
        self.stdout.write(self.style.SUCCESS(
            f"Insight #{insight.id} saved. Recommendations: {len(insight.targeting_recommendations)}"
        ))

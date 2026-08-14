from __future__ import annotations

import datetime as dt

from .models import AdSpend, MarketingInsight


def insights_list(limit: int = 20):
    return MarketingInsight.objects.all()[:limit]


def latest_insight() -> MarketingInsight | None:
    return MarketingInsight.objects.first()


def adspend_filtered(
    *,
    date_from: dt.date | None = None,
    date_to: dt.date | None = None,
    source_id: int | None = None,
):
    """
    Filter AdSpend rows. `date_from`/`date_to` overlap semantics: any row
    whose period intersects the filter window is returned.
    """
    qs = AdSpend.objects.all().select_related("source", "created_by")
    if date_from:
        qs = qs.filter(period_end__gte=date_from)
    if date_to:
        qs = qs.filter(period_start__lte=date_to)
    if source_id is not None:
        qs = qs.filter(source_id=source_id)
    return qs

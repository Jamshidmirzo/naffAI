from __future__ import annotations

from .models import MarketingInsight


def insights_list(limit: int = 20):
    return MarketingInsight.objects.all()[:limit]


def latest_insight() -> MarketingInsight | None:
    return MarketingInsight.objects.first()

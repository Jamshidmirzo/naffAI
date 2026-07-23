"""
Marketing insight — one row per analysis run.
Populated by the ``run_marketing_analyst`` management command.
"""

from __future__ import annotations

from django.db import models

from apps.common.models import TimestampedModel


class MarketingInsight(TimestampedModel):
    period_start = models.DateField()
    period_end = models.DateField()
    lead_quality_by_source = models.JSONField(default=dict)
    targeting_recommendations = models.JSONField(default=list)
    top_products = models.JSONField(default=list)
    summary = models.TextField(blank=True, default="")
    model_version = models.CharField(max_length=64, default="")

    class Meta:
        unique_together = [("period_start", "period_end")]
        indexes = [models.Index(fields=["-period_start"])]
        ordering = ["-period_start"]

    def __str__(self) -> str:
        return f"Insight {self.period_start}..{self.period_end}"

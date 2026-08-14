"""
Marketing models.

- `MarketingInsight` — one row per LLM analysis run for a period. Rich
  `structured_output` JSON field holds the marketer-persona payload
  (summary + highlights + recommendations + questions) while the old
  fields (`summary`, `targeting_recommendations`, `top_products`,
  `lead_quality_by_source`) are still populated for back-compat with the
  original Marketing.tsx page.
- `AdSpend` — per-period ad-spend record per acquisition source. Feeds
  CAC / ROI calculation in the source breakdown.
"""

from __future__ import annotations

from django.conf import settings
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
    provider_used = models.CharField(max_length=32, blank=True, default="")

    # Rich marketer-persona output — JSON schema:
    #   {"summary": str, "highlights": [...], "recommendations": [...],
    #    "questions_for_owner": [...]}
    structured_output = models.JSONField(default=dict, blank=True)
    # Recommendation indices the team lead has marked "done".
    actions_taken = models.JSONField(default=list, blank=True)
    # Snapshot of the raw data payload we sent to the LLM. Kept so the FE
    # can render the dashboard consistently even if underlying data
    # changes later (e.g. leads reassigned).
    dashboard_payload_snapshot = models.JSONField(default=dict, blank=True)

    class Meta:
        unique_together = [("period_start", "period_end")]
        indexes = [models.Index(fields=["-period_start"])]
        ordering = ["-period_start"]

    def __str__(self) -> str:
        return f"Insight {self.period_start}..{self.period_end}"


class AdSpend(TimestampedModel):
    """
    Ad-spend record for a period + source. Used by CAC/ROI calculation.

    - `source` FK is optional — for sheet sources we bind by FK, for
      BOT/MANUAL/custom labels we store the label string in `source_label`.
      One of the two MUST be set.
    - `period_start` / `period_end` are inclusive dates.
    - `amount` in UZS (Decimal). Positive numbers only.
    """

    period_start = models.DateField()
    period_end = models.DateField()
    source = models.ForeignKey(
        "leads.SheetSource",
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="ad_spend_rows",
        help_text="If bound to a sheet source, use FK. Otherwise leave null and set source_label.",
    )
    source_label = models.CharField(
        max_length=128,
        blank=True,
        default="",
        help_text="For BOT / MANUAL / custom acquisition channels not modelled as SheetSource.",
    )
    amount = models.DecimalField(max_digits=14, decimal_places=2)
    currency = models.CharField(max_length=8, default="UZS")
    note = models.TextField(blank=True, default="")
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="+",
    )

    class Meta:
        ordering = ["-period_start", "-id"]
        indexes = [
            models.Index(fields=["period_start", "period_end"]),
            models.Index(fields=["source", "period_start"]),
        ]

    def __str__(self) -> str:
        who = self.source.name if self.source_id else (self.source_label or "?")
        return f"AdSpend {who}: {self.amount} {self.currency} ({self.period_start}..{self.period_end})"

    @property
    def resolved_label(self) -> str:
        if self.source_id and self.source:
            return self.source.name
        return self.source_label or "Другое"

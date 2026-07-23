"""
Daily-quote cache + per-operator "already shown today" flag.

Design:
- One row in ``DailyQuote`` per (date, language). Shared by every
  operator that speaks that language — LLM cost is 2 calls/day at most.
- ``DailyGreetingShown`` records that a specific operator has already
  seen the day's quote so the UI stops popping the modal on every
  reload.
"""

from __future__ import annotations

from django.db import models

from apps.common.models import TimestampedModel


class DailyQuote(TimestampedModel):
    quote_date = models.DateField(db_index=True)
    language = models.CharField(max_length=8, default="ru")
    text = models.TextField()
    author = models.CharField(max_length=128, blank=True, default="")
    generated_by_model = models.CharField(max_length=64, default="")

    class Meta:
        unique_together = [("quote_date", "language")]
        indexes = [models.Index(fields=["-quote_date"])]

    def __str__(self) -> str:
        return f"{self.quote_date} [{self.language}]"


class DailyGreetingShown(TimestampedModel):
    operator = models.ForeignKey(
        "operators.Operator",
        on_delete=models.CASCADE,
        related_name="greeting_receipts",
    )
    date = models.DateField(db_index=True)

    class Meta:
        unique_together = [("operator", "date")]

    def __str__(self) -> str:
        return f"greeting({self.operator_id}, {self.date})"

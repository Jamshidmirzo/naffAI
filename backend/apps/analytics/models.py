"""
Analytics-owned data models.

This module intentionally stays small — analytics is mostly a read-side
package (see `selectors.py`). What lives here is only the data the
dashboard needs that has no better home in a domain app:

  * `SalesTarget` — team-wide sales plan for a calendar period (daily /
    weekly / monthly). The dashboard uses it to render the «оборот»
    plan-vs-actual hint and the bar-chart's dashed reference line.
"""
from __future__ import annotations

from django.db import models

from apps.common.models import TimestampedModel


class SalesTargetPeriod(models.TextChoices):
    DAILY = "daily", "День"
    WEEKLY = "weekly", "Неделя"
    MONTHLY = "monthly", "Месяц"


class SalesTarget(TimestampedModel):
    """Command-wide sales plan for a specific period.

    `period_start` is the calendar anchor for the period:
      * DAILY   → that exact date
      * WEEKLY  → Monday of the ISO week
      * MONTHLY → 1st of the month

    Uniqueness is `(period_type, period_start)` — one plan per bucket.
    A missing row simply means «no plan set» — the dashboard falls back
    to `null` and hides the plan hint.

    `target_amount` — сумма (net, UZS) — сколько команда должна оборотить.
    `target_count`  — сколько ЕДИНИЦ (штук) продать за период. В UI
    выводится как «план 18» на бар-чарте.
    """

    period_type = models.CharField(
        max_length=8,
        choices=SalesTargetPeriod.choices,
        default=SalesTargetPeriod.WEEKLY,
    )
    period_start = models.DateField(
        help_text="Календарный якорь: точная дата для DAILY, "
        "понедельник — для WEEKLY, 1-е число — для MONTHLY.",
    )
    target_amount = models.DecimalField(
        max_digits=14,
        decimal_places=2,
        default=0,
        help_text="Плановая сумма продаж (net, UZS) за период.",
    )
    target_count = models.PositiveIntegerField(
        default=0,
        help_text="Плановое число продаж (шт.) за период.",
    )
    note = models.CharField(max_length=200, blank=True, default="")

    class Meta:
        ordering = ["-period_start", "period_type"]
        constraints = [
            models.UniqueConstraint(
                fields=["period_type", "period_start"],
                name="uniq_sales_target_period",
            ),
        ]
        indexes = [
            models.Index(fields=["period_type", "-period_start"]),
        ]

    def __str__(self) -> str:
        return f"{self.get_period_type_display()} {self.period_start} → {self.target_count} шт."

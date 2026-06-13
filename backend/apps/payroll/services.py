from __future__ import annotations

import calendar
import datetime as dt
from collections.abc import Iterable
from dataclasses import dataclass
from decimal import Decimal

from django.utils import timezone

from apps.operators.models import Operator, OperatorStatus
from apps.sales.selectors import operator_sales_aggregate

from .models import PayoutType, PayrollRule
from .selectors import payroll_rule_for


@dataclass
class PayrollLine:
    operator_id: int
    operator_name: str
    is_trainee: bool
    total_sales: Decimal
    sales_count: int
    threshold: Decimal
    threshold_reached: bool
    payout: Decimal
    payout_type: str
    payout_value: Decimal
    progress_percent: float

    def as_dict(self) -> dict:
        return {
            "operator_id": self.operator_id,
            "operator_name": self.operator_name,
            "is_trainee": self.is_trainee,
            "total_sales": str(self.total_sales),
            "sales_count": self.sales_count,
            "threshold": str(self.threshold),
            "threshold_reached": self.threshold_reached,
            "payout": str(self.payout),
            "payout_type": self.payout_type,
            "payout_value": str(self.payout_value),
            "progress_percent": round(self.progress_percent, 1),
        }


def month_range(year: int, month: int) -> tuple[dt.datetime, dt.datetime]:
    tz = timezone.get_current_timezone()
    first = dt.datetime(year, month, 1, 0, 0, 0, tzinfo=tz)
    last_day = calendar.monthrange(year, month)[1]
    last = dt.datetime(year, month, last_day, 23, 59, 59, tzinfo=tz)
    return first, last


def compute_payout(total_sales: Decimal, rule: PayrollRule) -> Decimal:
    """Pure function — no DB. Trivially unit-testable."""
    if total_sales < rule.threshold:
        return Decimal("0")

    if rule.payout_type == PayoutType.FIXED:
        return Decimal(rule.payout_value).quantize(Decimal("0.01"))

    if rule.payout_type == PayoutType.PERCENT:
        excess = total_sales - rule.threshold
        return (excess * Decimal(rule.payout_value) / Decimal("100")).quantize(Decimal("0.01"))

    if rule.payout_type == PayoutType.TIERS:
        payout = Decimal("0")
        sorted_tiers = sorted(rule.tiers or [], key=lambda t: Decimal(str(t.get("from", 0))))
        for i, tier in enumerate(sorted_tiers):
            tier_from = Decimal(str(tier.get("from", 0)))
            rate = Decimal(str(tier.get("rate_percent", 0)))
            next_from = (
                Decimal(str(sorted_tiers[i + 1].get("from", 0)))
                if i + 1 < len(sorted_tiers)
                else None
            )
            if total_sales <= tier_from:
                break
            slab_top = min(total_sales, next_from) if next_from else total_sales
            slab = slab_top - tier_from
            payout += slab * rate / Decimal("100")
        return payout.quantize(Decimal("0.01"))

    return Decimal("0")


def compute_monthly_payroll(
    *,
    year: int,
    month: int,
    include_trainees: bool = True,
    operators: Iterable[Operator] | None = None,
) -> list[PayrollLine]:
    date_from, date_to = month_range(year, month)
    if operators is None:
        operators = Operator.objects.exclude(status=OperatorStatus.INACTIVE).order_by("full_name")

    lines: list[PayrollLine] = []
    for op in operators:
        agg = operator_sales_aggregate(operator_id=op.id, date_from=date_from, date_to=date_to)
        rule = payroll_rule_for(op.id)
        threshold = rule.threshold if rule else Decimal("50000000")
        if rule:
            payout = compute_payout(agg["total"], rule)
            payout_type = rule.payout_type
            payout_value = rule.payout_value
        else:
            payout = Decimal("0")
            payout_type = "none"
            payout_value = Decimal("0")
        is_trainee = op.status == OperatorStatus.TRAINEE
        if is_trainee and not include_trainees:
            continue

        progress = float(agg["total"]) / float(threshold) * 100 if threshold else 0.0
        lines.append(
            PayrollLine(
                operator_id=op.id,
                operator_name=op.full_name,
                is_trainee=is_trainee,
                total_sales=agg["total"],
                sales_count=agg["count"],
                threshold=threshold,
                threshold_reached=agg["total"] >= threshold,
                payout=payout,
                payout_type=payout_type,
                payout_value=payout_value,
                progress_percent=min(progress, 999.0),
            )
        )
    return lines

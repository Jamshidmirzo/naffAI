from __future__ import annotations

import datetime as dt
from decimal import Decimal

from django.db.models import Avg, Count, F, Sum
from django.db.models.functions import TruncDate
from django.utils import timezone

from apps.operators.models import Operator, OperatorStatus
from apps.sales.models import Sale, SaleOperator, SalePartner

# All analytics on the Sale side report NET revenue: gross amount minus
# the per-sale discount. Operator-line aggregations (SaleOperator) are
# already net by construction — see `_apply_discount_to_operator_lines`
# in apps.sales.services — so they keep using Sum("amount").
NET_AMOUNT = F("amount") - F("discount")


def _base_qs(date_from: dt.datetime | None = None, date_to: dt.datetime | None = None):
    qs = Sale.objects.filter(is_deleted=False, is_returned=False, status="confirmed")
    if date_from:
        qs = qs.filter(sold_at__gte=date_from)
    if date_to:
        qs = qs.filter(sold_at__lte=date_to)
    return qs


def _line_qs(
    model,
    *,
    date_from: dt.datetime | None = None,
    date_to: dt.datetime | None = None,
):
    """SaleOperator / SalePartner queryset gated to confirmed, non-deleted, non-returned sales."""
    qs = model.objects.filter(
        sale__is_deleted=False, sale__is_returned=False, sale__status="confirmed"
    )
    if date_from:
        qs = qs.filter(sale__sold_at__gte=date_from)
    if date_to:
        qs = qs.filter(sale__sold_at__lte=date_to)
    return qs


def kpi_snapshot() -> dict:
    now = timezone.now()
    start_of_day = now.replace(hour=0, minute=0, second=0, microsecond=0)
    start_of_week = start_of_day - dt.timedelta(days=now.weekday())
    start_of_month = start_of_day.replace(day=1)

    def agg(date_from):
        a = _base_qs(date_from=date_from).aggregate(total=Sum(NET_AMOUNT), count=Count("id"))
        return {"total": str(a["total"] or Decimal("0")), "count": a["count"] or 0}

    operators_active = Operator.objects.filter(status=OperatorStatus.ACTIVE).count()
    operators_trainee = Operator.objects.filter(status=OperatorStatus.TRAINEE).count()

    top = (
        _line_qs(SaleOperator, date_from=start_of_month)
        .values("operator_id", "operator__full_name")
        .annotate(total=Sum("amount"), count=Count("sale", distinct=True))
        .order_by("-total")
        .first()
    )

    return {
        "today": agg(start_of_day),
        "week": agg(start_of_week),
        "month": agg(start_of_month),
        "operators_active": operators_active,
        "operators_trainee": operators_trainee,
        "top_of_month": (
            {
                "operator_id": top["operator_id"],
                "operator_name": top["operator__full_name"],
                "total": str(top["total"]),
                "count": top["count"],
            }
            if top
            else None
        ),
    }


def leaderboard(
    *, date_from: dt.datetime | None = None, date_to: dt.datetime | None = None, limit: int = 20
) -> list[dict]:
    """Per-operator credit aggregated from SaleOperator lines (multi-op aware)."""
    rows = (
        _line_qs(SaleOperator, date_from=date_from, date_to=date_to)
        .values("operator_id", "operator__full_name", "operator__status")
        .annotate(total=Sum("amount"), count=Count("sale", distinct=True), avg_ticket=Avg("amount"))
        .order_by("-total")[:limit]
    )
    return [
        {
            "operator_id": r["operator_id"],
            "operator_name": r["operator__full_name"],
            "is_trainee": r["operator__status"] == OperatorStatus.TRAINEE,
            "total": str(r["total"] or 0),
            "count": r["count"],
            "avg_ticket": str(r["avg_ticket"] or 0),
        }
        for r in rows
    ]


def by_channel(*, date_from=None, date_to=None) -> list[dict]:
    """Per-partner totals aggregated from SalePartner lines (multi-partner aware)."""
    rows = (
        _line_qs(SalePartner, date_from=date_from, date_to=date_to)
        .values("partner_id", "partner__name")
        .annotate(total=Sum("amount"), count=Count("sale", distinct=True))
        .order_by("-total")
    )
    return [
        {
            "channel_id": r["partner_id"],
            "channel_name": r["partner__name"],
            "total": str(r["total"] or 0),
            "count": r["count"],
        }
        for r in rows
    ]


def by_model(*, date_from=None, date_to=None, limit: int = 20) -> list[dict]:
    qs = _base_qs(date_from=date_from, date_to=date_to)
    rows = (
        qs.values("phone_model")
        .annotate(total=Sum(NET_AMOUNT), count=Count("id"))
        .order_by("-count")[:limit]
    )
    return [
        {"phone_model": r["phone_model"], "total": str(r["total"] or 0), "count": r["count"]}
        for r in rows
    ]


def timeseries_daily(*, date_from, date_to) -> list[dict]:
    qs = _base_qs(date_from=date_from, date_to=date_to)
    rows = (
        qs.annotate(day=TruncDate("sold_at"))
        .values("day")
        .annotate(total=Sum(NET_AMOUNT), count=Count("id"))
        .order_by("day")
    )
    return [
        {"day": r["day"].isoformat(), "total": str(r["total"] or 0), "count": r["count"]}
        for r in rows
    ]

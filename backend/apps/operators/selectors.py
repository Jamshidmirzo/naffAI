from __future__ import annotations

import datetime as dt
from decimal import Decimal

from django.db.models import Count, F, Q, QuerySet, Sum
from django.db.models.functions import TruncDate

from apps.sales.models import Sale, SaleOperator, SalePartner

from .models import Operator, OperatorStatus


def operator_list(
    *,
    search: str | None = None,
    status: str | None = None,
    include_inactive: bool = True,
) -> QuerySet[Operator]:
    qs = Operator.objects.all()
    if not include_inactive:
        qs = qs.exclude(status="inactive")
    if status:
        qs = qs.filter(status=status)
    if search:
        qs = qs.filter(Q(full_name__icontains=search) | Q(phone__icontains=search))
    return qs


def operator_get(pk: int) -> Operator | None:
    return Operator.objects.filter(pk=pk).first()


# ---- per-operator statistics (dashboard drill-in) ---------------------

# NET on the Sale side = gross amount − discount. On the SaleOperator side
# it's already net (see apps.sales.services._apply_discount_to_operator_lines).
NET_AMOUNT = F("amount") - F("discount")


def _sale_qs_for_operator(
    *,
    operator_id: int,
    date_from: dt.datetime | None,
    date_to: dt.datetime | None,
) -> QuerySet[Sale]:
    """
    Every confirmed, non-returned, non-deleted Sale this operator is on —
    either as the legacy primary FK, or via a SaleOperator allocation row.
    """
    qs = Sale.objects.filter(
        is_deleted=False,
        is_returned=False,
        status="confirmed",
    ).filter(
        Q(operator_id=operator_id) | Q(operator_lines__operator_id=operator_id)
    ).distinct()
    if date_from:
        qs = qs.filter(sold_at__gte=date_from)
    if date_to:
        qs = qs.filter(sold_at__lte=date_to)
    return qs


def _operator_line_qs(
    *,
    operator_id: int,
    date_from: dt.datetime | None,
    date_to: dt.datetime | None,
) -> QuerySet[SaleOperator]:
    """
    SaleOperator lines for this operator, gated to confirmed/non-returned/non-deleted
    sales. This is the source of truth for the operator's credited share.
    """
    qs = SaleOperator.objects.filter(
        operator_id=operator_id,
        sale__is_deleted=False,
        sale__is_returned=False,
        sale__status="confirmed",
    )
    if date_from:
        qs = qs.filter(sale__sold_at__gte=date_from)
    if date_to:
        qs = qs.filter(sale__sold_at__lte=date_to)
    return qs


def operator_stats(
    *,
    operator: Operator,
    date_from: dt.datetime | None,
    date_to: dt.datetime | None,
    top_limit: int = 20,
) -> dict:
    """
    Full statistics slice for one operator in the given window:
      - totals  → credited sum + sale count (from SaleOperator allocations)
      - by_model    → per-model count/total from Sales the op was on
      - by_partner  → per-partner count/total from SalePartner lines on those sales
      - by_day      → daily count/total from Sales the op was on
    """
    # 1) totals from SaleOperator (multi-op aware, already net of discount)
    line_qs = _operator_line_qs(
        operator_id=operator.id, date_from=date_from, date_to=date_to
    )
    totals = line_qs.aggregate(
        total=Sum("amount"),
        count=Count("sale", distinct=True),
    )
    total_credited = totals["total"] or Decimal("0")
    sales_count = totals["count"] or 0

    # 2) Sale-side aggregates — this operator's sales set
    sale_qs = _sale_qs_for_operator(
        operator_id=operator.id, date_from=date_from, date_to=date_to
    )

    # by model — count is # of sales, total is net gross of that model
    by_model_rows = (
        sale_qs.values("phone_model")
        .annotate(count=Count("id"), total=Sum(NET_AMOUNT))
        .order_by("-count", "-total")[:top_limit]
    )
    by_model = [
        {
            "phone_model": r["phone_model"],
            "count": r["count"],
            "total": str(r["total"] or Decimal("0")),
        }
        for r in by_model_rows
    ]

    # by partner — sum SalePartner allocations from this op's sales
    partner_rows = (
        SalePartner.objects.filter(sale__in=sale_qs)
        .values("partner_id", "partner__name")
        .annotate(count=Count("sale", distinct=True), total=Sum("amount"))
        .order_by("-total")
    )
    by_partner = [
        {
            "partner_id": r["partner_id"],
            "partner_name": r["partner__name"],
            "count": r["count"],
            "total": str(r["total"] or Decimal("0")),
        }
        for r in partner_rows
    ]

    # by day — buckets of the sale set, net
    day_rows = (
        sale_qs.annotate(day=TruncDate("sold_at"))
        .values("day")
        .annotate(count=Count("id"), total=Sum(NET_AMOUNT))
        .order_by("day")
    )
    by_day = [
        {
            "day": r["day"].isoformat(),
            "count": r["count"],
            "total": str(r["total"] or Decimal("0")),
        }
        for r in day_rows
    ]

    return {
        "operator": {
            "id": operator.id,
            "full_name": operator.full_name,
            "phone": operator.phone,
            "status": operator.status,
            "is_trainee": operator.status == OperatorStatus.TRAINEE,
            "hired_at": operator.hired_at.isoformat() if operator.hired_at else None,
            "note": operator.note,
        },
        "window": {
            "date_from": date_from.isoformat() if date_from else None,
            "date_to": date_to.isoformat() if date_to else None,
        },
        "totals": {
            "total": str(total_credited),
            "count": sales_count,
        },
        "by_model": by_model,
        "by_partner": by_partner,
        "by_day": by_day,
    }

from __future__ import annotations

import datetime as dt
from decimal import Decimal

from django.db.models import Count, DecimalField, F, OuterRef, Q, QuerySet, Subquery, Sum, Value
from django.db.models.functions import Coalesce, TruncDate, TruncMonth
from django.utils import timezone

from apps.sales.models import Sale, SaleOperator, SalePartner

from .models import Operator, OperatorMonthlyPlan, OperatorStatus


def operator_list(
    *,
    search: str | None = None,
    status: str | None = None,
    include_inactive: bool = True,
    with_plan: bool = False,
) -> QuerySet[Operator]:
    qs = Operator.objects.all()
    if not include_inactive:
        qs = qs.exclude(status="inactive")
    if status:
        qs = qs.filter(status=status)
    if search:
        qs = qs.filter(Q(full_name__icontains=search) | Q(phone__icontains=search))
    if with_plan:
        today = dt.date.today()
        plan_subq = OperatorMonthlyPlan.objects.filter(
            operator_id=OuterRef("pk"), year=today.year, month=today.month
        ).values("target_amount")[:1]
        actual_subq = (
            SaleOperator.objects.filter(
                operator_id=OuterRef("pk"),
                sale__is_deleted=False,
                sale__is_returned=False,
                sale__status="confirmed",
                sale__sold_at__year=today.year,
                sale__sold_at__month=today.month,
            )
            .values("operator_id")
            .annotate(s=Sum("amount"))
            .values("s")[:1]
        )
        qs = qs.annotate(
            plan_target=Subquery(plan_subq, output_field=DecimalField()),
            plan_actual=Coalesce(
                Subquery(actual_subq, output_field=DecimalField()),
                Value(Decimal("0")),
            ),
        )
    return qs


def operator_plan_progress(*, operator: Operator, year: int, month: int) -> dict:
    plan = OperatorMonthlyPlan.objects.filter(operator=operator, year=year, month=month).first()
    target = plan.target_amount if plan else None
    actual = (
        SaleOperator.objects.filter(
            operator=operator,
            sale__is_deleted=False,
            sale__is_returned=False,
            sale__status="confirmed",
            sale__sold_at__year=year,
            sale__sold_at__month=month,
        ).aggregate(total=Sum("amount"))["total"]
        or Decimal("0")
    )
    percent = int(actual / target * 100) if target and target > 0 else 0
    return {
        "year": year,
        "month": month,
        "target": str(target) if target is not None else None,
        "actual": str(actual),
        "percent": min(percent, 100),
    }


def operator_get(pk: int) -> Operator | None:
    return Operator.objects.filter(pk=pk).first()


def _sales_streak(*, operator: Operator) -> int:
    """Count consecutive calendar days with ≥1 sale, ending at today (or yesterday)."""
    tz = timezone.get_current_timezone()
    today = timezone.localdate()
    window_start = dt.datetime.combine(today - dt.timedelta(days=90), dt.time.min, tzinfo=tz)

    raw = (
        SaleOperator.objects.filter(
            operator=operator,
            sale__is_deleted=False,
            sale__is_returned=False,
            sale__status="confirmed",
            sale__sold_at__gte=window_start,
        )
        .annotate(day=TruncDate("sale__sold_at"))
        .values_list("day", flat=True)
        .distinct()
    )
    dates = {d if isinstance(d, dt.date) else d.date() for d in raw}

    streak = 0
    check = today
    while check in dates:
        streak += 1
        check -= dt.timedelta(days=1)
    if streak == 0:
        check = today - dt.timedelta(days=1)
        while check in dates:
            streak += 1
            check -= dt.timedelta(days=1)
    return streak


def operator_achievements(*, operator: Operator, year: int, month: int) -> list[dict]:
    """
    Returns earned badges for the operator in the given year/month.
    Each entry: {"slug": str, "emoji": str, "label": str}
    """
    tz = timezone.get_current_timezone()
    today = timezone.localdate()
    badges: list[dict] = []

    # 🔥 Best today — highest sales amount today (always relative to now)
    today_start = dt.datetime.combine(today, dt.time.min, tzinfo=tz)
    today_end = today_start + dt.timedelta(days=1)
    top_today = (
        SaleOperator.objects.filter(
            sale__sold_at__gte=today_start,
            sale__sold_at__lt=today_end,
            sale__is_deleted=False,
            sale__is_returned=False,
            sale__status="confirmed",
        )
        .values("operator_id")
        .annotate(total=Sum("amount"))
        .order_by("-total")
        .first()
    )
    if top_today and top_today["operator_id"] == operator.id and top_today["total"]:
        badges.append({"slug": "best_today", "emoji": "🔥", "label": "Лучший сегодня"})

    # ⚡ Personal record month — this month's total ≥ any previous month
    month_start = dt.datetime(year, month, 1, tzinfo=tz)
    next_month = (month % 12) + 1
    next_year = year + (1 if month == 12 else 0)
    month_end = dt.datetime(next_year, next_month, 1, tzinfo=tz)

    this_total = (
        SaleOperator.objects.filter(
            operator=operator,
            sale__sold_at__gte=month_start,
            sale__sold_at__lt=month_end,
            sale__is_deleted=False,
            sale__is_returned=False,
            sale__status="confirmed",
        ).aggregate(total=Sum("amount"))["total"]
        or Decimal("0")
    )
    prev_best = (
        SaleOperator.objects.filter(
            operator=operator,
            sale__sold_at__lt=month_start,
            sale__is_deleted=False,
            sale__is_returned=False,
            sale__status="confirmed",
        )
        .annotate(mo=TruncMonth("sale__sold_at"))
        .values("mo")
        .annotate(s=Sum("amount"))
        .order_by("-s")
        .values_list("s", flat=True)
        .first()
    )
    if this_total > 0 and (prev_best is None or this_total >= prev_best):
        badges.append({"slug": "record_month", "emoji": "⚡", "label": "Рекорд месяца"})

    # ✅ Plan complete
    plan = operator_plan_progress(operator=operator, year=year, month=month)
    if plan["target"] is not None and plan["percent"] >= 100:
        badges.append({"slug": "plan_done", "emoji": "✅", "label": "План выполнен"})

    # 📈 Consecutive-days streak
    streak = _sales_streak(operator=operator)
    if streak >= 2:
        badges.append({"slug": "streak", "emoji": "📈", "label": f"+{streak} дней подряд"})

    return badges


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

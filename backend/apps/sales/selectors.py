from __future__ import annotations

import datetime as dt
from decimal import Decimal

from django.db.models import Count, Q, QuerySet, Sum

from .models import Sale


def sale_queryset(*, include_deleted: bool = False) -> QuerySet[Sale]:
    qs = Sale.objects.select_related("operator", "channel", "created_by").prefetch_related("gifts")
    if not include_deleted:
        qs = qs.filter(is_deleted=False)
    return qs


def sale_list(
    *,
    search: str | None = None,
    operator_id: int | None = None,
    channel_id: int | None = None,
    date_from: dt.datetime | None = None,
    date_to: dt.datetime | None = None,
    status: str | None = None,
    is_returned: bool | None = None,
) -> QuerySet[Sale]:
    qs = sale_queryset()
    if search:
        qs = qs.filter(
            Q(imei__icontains=search)
            | Q(phone_model__icontains=search)
            | Q(operator__full_name__icontains=search)
        )
    if operator_id:
        qs = qs.filter(operator_id=operator_id)
    if channel_id:
        qs = qs.filter(channel_id=channel_id)
    if date_from:
        qs = qs.filter(sold_at__gte=date_from)
    if date_to:
        qs = qs.filter(sold_at__lte=date_to)
    if status:
        qs = qs.filter(status=status)
    if is_returned is not None:
        qs = qs.filter(is_returned=is_returned)
    return qs


def sale_get(pk: int) -> Sale | None:
    return sale_queryset(include_deleted=True).filter(pk=pk).first()


def sale_imei_duplicate_count(*, imei: str, exclude_id: int | None = None) -> int:
    """Counts non-deleted, non-returned sales with the same IMEI."""
    qs = Sale.objects.filter(imei=imei, is_deleted=False, is_returned=False)
    if exclude_id:
        qs = qs.exclude(pk=exclude_id)
    return qs.count()


def operator_sales_aggregate(
    *,
    operator_id: int,
    date_from: dt.datetime,
    date_to: dt.datetime,
) -> dict:
    """Net of returned and deleted sales — used by payroll + dashboards."""
    qs = Sale.objects.filter(
        operator_id=operator_id,
        sold_at__gte=date_from,
        sold_at__lte=date_to,
        is_returned=False,
        is_deleted=False,
        status="confirmed",
    )
    agg = qs.aggregate(total=Sum("amount"), count=Count("id"))
    total = agg["total"] or Decimal("0")
    count = agg["count"] or 0
    return {"total": total, "count": count}

from __future__ import annotations

import datetime as dt
from decimal import Decimal

from django.db.models import Count, Q, QuerySet, Sum

from .models import Sale, SaleOperator


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
    operator_ids: list[int] | None = None,
    partner_ids: list[int] | None = None,
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
            | Q(operator_lines__operator__full_name__icontains=search)
        ).distinct()
    if operator_id:
        # Sale matches if the operator is the primary OR a line credit.
        qs = qs.filter(
            Q(operator_id=operator_id) | Q(operator_lines__operator_id=operator_id)
        ).distinct()
    if operator_ids:
        # Multi-select: match if any of the listed operators credit the sale
        # — either as the legacy primary FK or via a SaleOperator allocation.
        qs = qs.filter(
            Q(operator_id__in=operator_ids) | Q(operator_lines__operator_id__in=operator_ids)
        ).distinct()
    if channel_id:
        qs = qs.filter(
            Q(channel_id=channel_id) | Q(partner_lines__partner_id=channel_id)
        ).distinct()
    if partner_ids:
        qs = qs.filter(
            Q(channel_id__in=partner_ids) | Q(partner_lines__partner_id__in=partner_ids)
        ).distinct()
    if date_from:
        qs = qs.filter(sold_at__gte=date_from)
    if date_to:
        qs = qs.filter(sold_at__lte=date_to)
    if status:
        qs = qs.filter(status=status)
    if is_returned is not None:
        qs = qs.filter(is_returned=is_returned)
    return qs.order_by("-sold_at", "-id")


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
    """
    Per-operator credit for payroll / dashboards.

    Aggregates the SaleOperator allocation amounts (not the Sale.amount FK
    shortcut), so when one sale is split across N operators every one of
    them only gets their share. Net of returned / deleted / pending sales.
    """
    qs = SaleOperator.objects.filter(
        operator_id=operator_id,
        sale__sold_at__gte=date_from,
        sale__sold_at__lte=date_to,
        sale__is_returned=False,
        sale__is_deleted=False,
        sale__status="confirmed",
    )
    agg = qs.aggregate(total=Sum("amount"), count=Count("sale", distinct=True))
    return {"total": agg["total"] or Decimal("0"), "count": agg["count"] or 0}

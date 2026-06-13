from __future__ import annotations

from django.db.models import Q, QuerySet

from .models import Operator


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

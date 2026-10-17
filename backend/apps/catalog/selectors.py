from __future__ import annotations

from django.db.models import QuerySet

from .models import Channel, InstallmentTier, TacLookup


def channel_list(*, active_only: bool = False) -> QuerySet[Channel]:
    qs = Channel.objects.all()
    if active_only:
        qs = qs.filter(is_active=True)
    return qs


def tac_get(tac: str) -> TacLookup | None:
    return TacLookup.objects.filter(tac=tac).first()


def installment_tier_list(*, active_only: bool = False) -> QuerySet[InstallmentTier]:
    qs = InstallmentTier.objects.all()
    if active_only:
        qs = qs.filter(is_active=True)
    return qs.order_by("sort_order", "months")


def installment_tiers_for_marketing(*, fallback_to_active: bool = False) -> list[InstallmentTier]:
    """
    Tiers shown next to a price: active + `show_in_marketing`, ordered
    (sort_order, months). The catalog card and the marketing text use them
    as is (nothing flagged → no installment block). The public site passes
    `fallback_to_active=True`: nothing flagged → every active tier, so the
    site never shows a phone without a monthly price.
    """
    base = InstallmentTier.objects.filter(is_active=True).order_by("sort_order", "months")
    tiers = list(base.filter(show_in_marketing=True))
    if not tiers and fallback_to_active:
        tiers = list(base)
    return tiers

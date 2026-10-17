from __future__ import annotations

from django.db.models import Prefetch, QuerySet

from .models import (
    Channel,
    InstallmentTier,
    MarketingSettings,
    PhoneColor,
    PhoneModel,
    PhoneSpinFrame,
    TacLookup,
)


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


# ---------------------------------------------------------------------------
# Public catalog (zetmobile.uz) — read-only, `is_active & show_on_site` only.
# ---------------------------------------------------------------------------


def public_phone_list() -> QuerySet[PhoneModel]:
    """
    Cards for the site's listing. Only frame #0 of every spin set is
    prefetched — the card needs the preview frame, not the whole spin.
    Ordering = PhoneModel.Meta.ordering.
    """
    return PhoneModel.objects.filter(is_active=True, show_on_site=True).prefetch_related(
        Prefetch("colors", queryset=PhoneColor.objects.order_by("sort_order", "name")),
        Prefetch(
            "spin_frames",
            queryset=PhoneSpinFrame.objects.filter(index=0),
            to_attr="spin_first_frames",
        ),
    )


def public_phone_get(*, slug: str) -> PhoneModel | None:
    spin_qs = PhoneSpinFrame.objects.order_by("color_id", "index")
    return (
        PhoneModel.objects.filter(is_active=True, show_on_site=True, site_slug=slug)
        .prefetch_related(
            Prefetch(
                "colors",
                queryset=PhoneColor.objects.order_by("sort_order", "name").prefetch_related(
                    Prefetch("spin_frames", queryset=spin_qs)
                ),
            ),
            Prefetch("spin_frames", queryset=spin_qs.filter(color__isnull=True), to_attr="spin_colorless"),
            "gallery",
        )
        .first()
    )


def public_store_settings() -> MarketingSettings:
    return MarketingSettings.load()

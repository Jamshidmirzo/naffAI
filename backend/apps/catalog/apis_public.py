"""
Public read-only catalog for the shop website (zetmobile.uz, a separate
Next.js app). Prices come from this catalog — the same numbers operators
quote — so the site never keeps its own price list.

  GET /api/public/catalog/phones/          cards (is_active & show_on_site)
  GET /api/public/catalog/phones/<slug>/   card + specs, gallery, 360°, per-color prices
  GET /api/public/catalog/store/           contacts + benefits (MarketingSettings)

Auth: `X-Site-Key: <PUBLIC_CATALOG_KEY>` checked with `hmac.compare_digest`;
empty setting = feature off (everything 401). The key is meant for the
site's server side only (SSR / route handlers), never for the browser.
No session / token auth here — no CSRF, no user.

Money is integer so'm everywhere. Installments use the shared formula
(`quote_builder.installment_monthly_rows`) so the site, the catalog card
and the marketing text always agree. Output is whitelisted field by field:
no internal ids, no created_by, no marketing text.
"""

from __future__ import annotations

import hmac
from decimal import ROUND_HALF_UP, Decimal

from django.conf import settings
from rest_framework import status
from rest_framework.exceptions import NotAuthenticated
from rest_framework.permissions import BasePermission
from rest_framework.response import Response
from rest_framework.throttling import AnonRateThrottle
from rest_framework.views import APIView

from .models import PhoneColor, PhoneModel
from .quote_builder import installment_monthly_rows
from .selectors import (
    installment_tiers_for_marketing,
    public_phone_get,
    public_phone_list,
    public_store_settings,
)


class HasSiteKey(BasePermission):
    message = "invalid site key"

    def has_permission(self, request, view) -> bool:
        expected = settings.PUBLIC_CATALOG_KEY or ""
        provided = request.headers.get("X-Site-Key") or ""
        if not expected or not provided:
            return False
        return hmac.compare_digest(provided.encode(), expected.encode())


class PublicCatalogThrottle(AnonRateThrottle):
    scope = "public_catalog"


class _PublicCatalogApi(APIView):
    authentication_classes = []
    permission_classes = [HasSiteKey]
    throttle_classes = [PublicCatalogThrottle]

    def permission_denied(self, request, message=None, code=None):
        # Without authenticators DRF would answer 403; a missing / wrong key
        # is an authentication problem → 401.
        raise NotAuthenticated(detail=message)

    def get_authenticate_header(self, request) -> str:
        return 'SiteKey header="X-Site-Key"'


# ---------------------------------------------------------------------------
# Output builders
# ---------------------------------------------------------------------------


def _som(value) -> int:
    """Decimal money → integer so'm, round half up."""
    return int(Decimal(value or 0).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def _abs(request, field) -> str | None:
    return request.build_absolute_uri(field.url) if field else None


def _color_price(phone: PhoneModel, color: PhoneColor) -> Decimal:
    return color.price_override or phone.price


def _card(phone: PhoneModel, *, request, tiers, first_frames) -> dict:
    """
    `first_frames` — frame #0 of every spin set of this phone (list view
    prefetches only those; detail passes the same slice of the full set).
    """
    colors = list(phone.colors.all())
    available = [c for c in colors if c.is_available]
    # Rows are computed from the stored Decimal, rounded only for output —
    # identical to the catalog card's `installment_preview`.
    price_from = min((_color_price(phone, c) for c in available), default=phone.price)

    by_color = {f.color_id: f for f in first_frames}
    preview = next((by_color[c.id] for c in available if c.id in by_color), None)
    if preview is None:
        preview = by_color.get(None)

    rows = installment_monthly_rows(price_from, tiers)
    cheapest = min(rows, key=lambda r: r["monthly"], default=None)

    return {
        "slug": phone.site_slug,
        "brand": phone.brand,
        "model_name": phone.model_name,
        "storage_gb": phone.storage_gb,
        "ram_gb": phone.ram_gb,
        "price": _som(phone.price),
        "price_from": _som(price_from),
        "stock_status": phone.stock_status,
        "tagline": phone.tagline,
        "cover_image_url": _abs(request, phone.cover_image),
        "spin_preview_url": _abs(request, preview.image) if preview else None,
        "has_spin": preview is not None,
        "colors": [{"name": c.name, "hex": c.hex_code} for c in available],
        "installment_from": (
            {"months": cheapest["months"], "monthly": cheapest["monthly"]} if cheapest else None
        ),
        "sort_order": phone.sort_order,
        "updated_at": phone.updated_at,
    }


def _specs(phone: PhoneModel) -> list[dict]:
    out: list[dict] = []
    for key, value in (phone.specs_json or {}).items():
        if value is None or str(value).strip() == "":
            continue
        out.append({"key": str(key), "value": str(value)})
    return out


def _detail(phone: PhoneModel, *, request, tiers) -> dict:
    colors = list(phone.colors.all())
    colorless = list(phone.spin_colorless)
    first_frames = [f for c in colors for f in c.spin_frames.all()[:1]] + colorless[:1]
    data = _card(phone, request=request, tiers=tiers, first_frames=first_frames)
    data.update(
        {
            "description_uz": phone.description,
            "description_ru": phone.description_ru,
            "camera_mp": phone.camera_mp,
            "battery_mah": phone.battery_mah,
            "specs": _specs(phone),
            "gallery": [_abs(request, g.photo) for g in phone.gallery.all()],
            "spin": [_abs(request, f.image) for f in colorless],
            "installments": installment_monthly_rows(phone.price, tiers),
            "colors": [
                {
                    "name": c.name,
                    "hex": c.hex_code,
                    "price": _som(_color_price(phone, c)),
                    "is_available": c.is_available,
                    "spin": [_abs(request, f.image) for f in c.spin_frames.all()],
                    "installments": installment_monthly_rows(_color_price(phone, c), tiers),
                }
                for c in colors
            ],
        }
    )
    return data


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


class PublicPhoneListApi(_PublicCatalogApi):
    def get(self, request):
        tiers = installment_tiers_for_marketing(fallback_to_active=True)
        results = [
            _card(p, request=request, tiers=tiers, first_frames=p.spin_first_frames)
            for p in public_phone_list()
        ]
        return Response({"results": results})


class PublicPhoneDetailApi(_PublicCatalogApi):
    def get(self, request, slug: str):
        phone = public_phone_get(slug=slug)
        if phone is None:
            return Response({"detail": "not found"}, status=status.HTTP_404_NOT_FOUND)
        tiers = installment_tiers_for_marketing(fallback_to_active=True)
        return Response(_detail(phone, request=request, tiers=tiers))


class PublicStoreApi(_PublicCatalogApi):
    def get(self, request):
        s = public_store_settings()
        return Response(
            {
                "phone_primary": s.phone_primary,
                "phone_secondary": s.phone_secondary,
                "telegram_handle": s.telegram_handle,
                "address": s.address,
                "benefits": [
                    line.strip() for line in (s.benefits or "").splitlines() if line.strip()
                ],
                "default_tagline": s.default_tagline,
            }
        )

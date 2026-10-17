"""
Public catalog for the shop website (/api/public/catalog/*).

Covers: X-Site-Key auth (missing / wrong / feature off), visibility
(is_active & show_on_site), the exact whitelist of card fields, per-color
prices, installments identical to the operator card's
`installment_preview` (+ fallback when no tier is flagged), site_slug
generation, and that the list endpoint has no N+1.
"""

from __future__ import annotations

from decimal import Decimal

import pytest
from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.core.files.base import ContentFile
from django.db import connection
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APIClient

from apps.catalog.apis_phones import PhoneModelSerializer
from apps.catalog.models import (
    InstallmentTier,
    MarketingSettings,
    PhoneColor,
    PhoneModel,
    PhoneSpinFrame,
)
from apps.users.models import Profile, Role

User = get_user_model()

pytestmark = pytest.mark.django_db

SITE_KEY = "test-site-key-123"
LIST_URL = "/api/public/catalog/phones/"
STORE_URL = "/api/public/catalog/store/"

CARD_KEYS = {
    "slug",
    "brand",
    "model_name",
    "storage_gb",
    "ram_gb",
    "price",
    "price_from",
    "stock_status",
    "tagline",
    "cover_image_url",
    "spin_preview_url",
    "has_spin",
    "colors",
    "installment_from",
    "sort_order",
    "updated_at",
}
DETAIL_EXTRA_KEYS = {
    "description_uz",
    "description_ru",
    "camera_mp",
    "battery_mah",
    "specs",
    "gallery",
    "spin",
    "installments",
}


@pytest.fixture(autouse=True)
def _site(settings, tmp_path):
    settings.PUBLIC_CATALOG_KEY = SITE_KEY
    settings.MEDIA_ROOT = str(tmp_path / "media")
    cache.clear()  # throttle counters live in the cache
    yield
    cache.clear()


@pytest.fixture
def site_client():
    c = APIClient()
    c.credentials(HTTP_X_SITE_KEY=SITE_KEY)
    return c


def _phone(**kw) -> PhoneModel:
    defaults = {
        "brand": "Apple",
        "model_name": "iPhone 16 Pro",
        "storage_gb": 256,
        "ram_gb": 8,
        "price": Decimal("17500000.00"),
        "is_active": True,
        "show_on_site": True,
    }
    defaults.update(kw)
    return PhoneModel.objects.create(**defaults)


def _frame(phone, color, index) -> PhoneSpinFrame:
    return PhoneSpinFrame.objects.create(
        phone=phone,
        color=color,
        index=index,
        image=ContentFile(b"webp", name=f"f{index}.webp"),
    )


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("url", [LIST_URL, STORE_URL, f"{LIST_URL}some-slug/"])
def test_missing_key_401(url):
    _phone(site_slug="some-slug")
    r = APIClient().get(url)
    assert r.status_code == 401


def test_wrong_key_401():
    c = APIClient()
    c.credentials(HTTP_X_SITE_KEY="nope")
    assert c.get(LIST_URL).status_code == 401


def test_empty_setting_denies_even_matching_header(settings):
    settings.PUBLIC_CATALOG_KEY = ""
    c = APIClient()
    c.credentials(HTTP_X_SITE_KEY="")
    assert c.get(LIST_URL).status_code == 401
    c.credentials(HTTP_X_SITE_KEY=SITE_KEY)
    assert c.get(LIST_URL).status_code == 401


def test_session_user_without_key_still_401():
    """A logged-in CRM user is not the site — the key is the only auth."""
    user = User.objects.create_user(username="mgr_public", password="x")
    Profile.objects.create(user=user, role=Role.MANAGER)
    c = APIClient()
    c.force_authenticate(user)
    assert c.get(LIST_URL).status_code == 401


# ---------------------------------------------------------------------------
# Visibility + shape
# ---------------------------------------------------------------------------


def test_list_only_active_and_on_site(site_client):
    visible = _phone(model_name="Visible")
    _phone(model_name="Hidden", show_on_site=False)
    _phone(model_name="Inactive", is_active=False)
    r = site_client.get(LIST_URL)
    assert r.status_code == 200
    assert [c["model_name"] for c in r.data["results"]] == ["Visible"]
    assert r.data["results"][0]["slug"] == visible.site_slug


def test_detail_404_for_hidden_inactive_unknown(site_client):
    hidden = _phone(model_name="Hidden", show_on_site=False)
    inactive = _phone(model_name="Inactive", is_active=False)
    for slug in (hidden.site_slug, inactive.site_slug, "no-such-phone"):
        assert site_client.get(f"{LIST_URL}{slug}/").status_code == 404


def test_card_exact_keys_no_internal_fields(site_client):
    phone = _phone(tagline="Zo'r")
    PhoneColor.objects.create(phone=phone, name="Black", hex_code="#000000")
    r = site_client.get(LIST_URL)
    card = r.data["results"][0]
    assert set(card) == CARD_KEYS
    assert set(card["colors"][0]) == {"name", "hex"}
    assert set(card["installment_from"]) == {"months", "monthly"}
    assert isinstance(card["price"], int) and card["price"] == 17_500_000

    d = site_client.get(f"{LIST_URL}{phone.site_slug}/").data
    assert set(d) == CARD_KEYS | DETAIL_EXTRA_KEYS
    assert set(d["colors"][0]) == {"name", "hex", "price", "is_available", "spin", "installments"}
    for forbidden in ("id", "created_by", "is_active", "marketing_text_uz", "show_on_site"):
        assert forbidden not in d


def test_list_ordering_follows_meta(site_client):
    _phone(model_name="B", sort_order=0)
    _phone(model_name="A", sort_order=0)
    _phone(model_name="Top", sort_order=10)
    names = [c["model_name"] for c in site_client.get(LIST_URL).data["results"]]
    assert names == ["Top", "A", "B"]


def test_color_price_override_and_availability(site_client):
    phone = _phone(price=Decimal("10000000.00"))
    PhoneColor.objects.create(
        phone=phone, name="Titanium", price_override=Decimal("12000000.00"), sort_order=0
    )
    PhoneColor.objects.create(
        phone=phone,
        name="Cheap-but-gone",
        price_override=Decimal("9000000.00"),
        is_available=False,
        sort_order=1,
    )
    PhoneColor.objects.create(phone=phone, name="Black", sort_order=2)

    card = site_client.get(LIST_URL).data["results"][0]
    assert card["price"] == 10_000_000
    # Unavailable color neither counts for price_from nor shows on the card.
    assert card["price_from"] == 10_000_000
    assert [c["name"] for c in card["colors"]] == ["Titanium", "Black"]

    d = site_client.get(f"{LIST_URL}{phone.site_slug}/").data
    prices = {c["name"]: (c["price"], c["is_available"]) for c in d["colors"]}
    assert prices == {
        "Titanium": (12_000_000, True),
        "Cheap-but-gone": (9_000_000, False),
        "Black": (10_000_000, True),
    }


def test_price_from_uses_cheapest_available_color(site_client):
    phone = _phone(price=Decimal("10000000.00"))
    PhoneColor.objects.create(phone=phone, name="Promo", price_override=Decimal("8000000.00"))
    card = site_client.get(LIST_URL).data["results"][0]
    assert card["price_from"] == 8_000_000
    # installment_from is the lowest monthly row for price_from (24 m @ 75%).
    assert card["installment_from"] == {"months": 24, "monthly": 584_000}


def test_money_rounds_half_up(site_client):
    _phone(price=Decimal("1000000.50"))
    assert site_client.get(LIST_URL).data["results"][0]["price"] == 1_000_001


# ---------------------------------------------------------------------------
# Installments — one formula with the operator card
# ---------------------------------------------------------------------------


def test_installments_match_internal_installment_preview(site_client):
    phone = _phone(price=Decimal("3599000.00"))
    PhoneColor.objects.create(phone=phone, name="Blue", price_override=Decimal("3799000.00"))
    preview = PhoneModelSerializer(phone).data["installment_preview"]
    assert preview  # seeded tiers 6/12/24 are flagged

    d = site_client.get(f"{LIST_URL}{phone.site_slug}/").data
    assert [{"months": r["months"], "monthly": r["monthly"]} for r in d["installments"]] == preview
    for row in d["installments"]:
        assert row["total"] == row["monthly"] * row["months"]
        assert isinstance(row["monthly"], int)
    # commission_pct as a 2-dp string, e.g. 6 m → "25.00".
    assert {r["months"]: r["commission_pct"] for r in d["installments"]}[6] == "25.00"
    # Per-color rows use the color price.
    blue = next(c for c in d["colors"] if c["name"] == "Blue")
    other = _phone(model_name="Same price twin", price=Decimal("3799000.00"))
    assert [
        {"months": r["months"], "monthly": r["monthly"]} for r in blue["installments"]
    ] == PhoneModelSerializer(other).data["installment_preview"]


def test_installments_fallback_to_all_active_when_none_flagged(site_client):
    InstallmentTier.objects.update(show_in_marketing=False)
    InstallmentTier.objects.filter(months=9).update(is_active=False)
    phone = _phone(price=Decimal("8000000.00"))

    d = site_client.get(f"{LIST_URL}{phone.site_slug}/").data
    active = list(
        InstallmentTier.objects.filter(is_active=True)
        .order_by("sort_order", "months")
        .values_list("months", flat=True)
    )
    assert [r["months"] for r in d["installments"]] == active
    assert 9 not in active
    # 12 m @ 38 %: 8M × 1.38 / 12 = 920 000.
    assert {r["months"]: r["monthly"] for r in d["installments"]}[12] == 920_000
    # The operator card keeps its rule: nothing flagged → no strip.
    assert PhoneModelSerializer(phone).data["installment_preview"] == []


# ---------------------------------------------------------------------------
# Spin preview / detail payload
# ---------------------------------------------------------------------------


def test_spin_preview_prefers_first_available_color_with_frames(site_client):
    phone = _phone()
    gone = PhoneColor.objects.create(phone=phone, name="Gone", is_available=False, sort_order=0)
    black = PhoneColor.objects.create(phone=phone, name="Black", sort_order=1)
    white = PhoneColor.objects.create(phone=phone, name="White", sort_order=2)
    for i in range(3):
        _frame(phone, gone, i)
        _frame(phone, white, i)
        _frame(phone, None, i)

    card = site_client.get(LIST_URL).data["results"][0]
    assert card["has_spin"] is True
    white_first = white.spin_frames.get(index=0).image.url
    assert card["spin_preview_url"].endswith(white_first)
    assert card["spin_preview_url"].startswith("http://testserver/")

    d = site_client.get(f"{LIST_URL}{phone.site_slug}/").data
    assert len(d["spin"]) == 3  # colorless set
    spins = {c["name"]: c["spin"] for c in d["colors"]}
    assert len(spins["White"]) == 3 and spins["Black"] == []
    assert spins["White"] == [
        f"http://testserver{f.image.url}" for f in white.spin_frames.order_by("index")
    ]
    assert black.spin_frames.count() == 0


def test_spin_preview_falls_back_to_colorless_then_null(site_client):
    with_spin = _phone(model_name="With spin")
    _frame(with_spin, None, 0)
    _phone(model_name="No spin")
    cards = {c["model_name"]: c for c in site_client.get(LIST_URL).data["results"]}
    assert cards["With spin"]["has_spin"] is True
    assert cards["No spin"]["has_spin"] is False
    assert cards["No spin"]["spin_preview_url"] is None


def test_detail_specs_skip_empty_and_keep_order(site_client):
    phone = _phone(
        specs_json={"screen": "6.3 OLED", "chip": "", "nfc": None, "weight": "199 g"},
        description="uz matn",
        description_ru="ru текст",
    )
    d = site_client.get(f"{LIST_URL}{phone.site_slug}/").data
    assert d["specs"] == [
        {"key": "screen", "value": "6.3 OLED"},
        {"key": "weight", "value": "199 g"},
    ]
    assert d["description_uz"] == "uz matn"
    assert d["description_ru"] == "ru текст"


def test_store_endpoint(site_client):
    s = MarketingSettings.load()
    s.benefits = "👎 Boshlang'ich to'lovsiz\n\n  \n⚙️ 1 yillik garantiya\n"
    s.save()
    r = site_client.get(STORE_URL)
    assert r.status_code == 200
    assert set(r.data) == {
        "phone_primary",
        "phone_secondary",
        "telegram_handle",
        "address",
        "benefits",
        "default_tagline",
    }
    assert r.data["benefits"] == ["👎 Boshlang'ich to'lovsiz", "⚙️ 1 yillik garantiya"]


# ---------------------------------------------------------------------------
# Query count — list must not grow with the number of phones
# ---------------------------------------------------------------------------


def _rich_phone(n: int) -> None:
    phone = _phone(model_name=f"Model {n}")
    for ci, name in enumerate(("Black", "White")):
        color = PhoneColor.objects.create(phone=phone, name=name, sort_order=ci)
        for i in range(3):
            _frame(phone, color, i)


def test_list_query_count_is_constant(site_client):
    _rich_phone(0)
    with CaptureQueriesContext(connection) as one:
        assert site_client.get(LIST_URL).status_code == 200
    for n in range(1, 6):
        _rich_phone(n)
    cache.clear()
    with CaptureQueriesContext(connection) as six:
        r = site_client.get(LIST_URL)
    assert len(r.data["results"]) == 6
    assert len(six) == len(one)
    assert len(six) <= 5


# ---------------------------------------------------------------------------
# site_slug
# ---------------------------------------------------------------------------


def test_site_slug_auto_and_collision_suffix():
    a = _phone()
    b = _phone()
    c = _phone()
    assert a.site_slug == "apple-iphone-16-pro-256gb"
    assert b.site_slug == "apple-iphone-16-pro-256gb-2"
    assert c.site_slug == "apple-iphone-16-pro-256gb-3"
    no_storage = _phone(brand="Xiaomi", model_name="Redmi Note 14", storage_gb=None)
    assert no_storage.site_slug == "xiaomi-redmi-note-14"


def test_site_slug_kept_on_rename_and_regenerated_when_cleared():
    phone = _phone()
    phone.model_name = "iPhone 16 Pro Max"
    phone.save()
    phone.refresh_from_db()
    assert phone.site_slug == "apple-iphone-16-pro-256gb"
    phone.site_slug = None
    phone.save(update_fields=["site_slug", "model_name"])
    phone.refresh_from_db()
    assert phone.site_slug == "apple-iphone-16-pro-max-256gb"


def test_site_slug_via_manager_api():
    user = User.objects.create_user(username="mgr_slug", password="x")
    Profile.objects.create(user=user, role=Role.MANAGER)
    c = APIClient()
    c.force_authenticate(user)
    taken = _phone(model_name="Taken")
    phone = _phone()
    url = f"/api/catalog/phones/{phone.id}/"

    r = c.patch(url, {"site_slug": "Not a slug!"}, format="json")
    assert r.status_code == 400 and "site_slug" in r.data
    r = c.patch(url, {"site_slug": taken.site_slug}, format="json")
    assert r.status_code == 400 and "site_slug" in r.data
    r = c.patch(
        url,
        {"site_slug": "iphone-16-pro-promo", "show_on_site": True, "description_ru": "Текст"},
        format="json",
    )
    assert r.status_code == 200, r.data
    assert r.data["site_slug"] == "iphone-16-pro-promo"
    assert r.data["description_ru"] == "Текст"
    r = c.patch(url, {"site_slug": ""}, format="json")
    assert r.status_code == 200
    assert r.data["site_slug"] == "apple-iphone-16-pro-256gb"

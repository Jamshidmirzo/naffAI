"""
Tests for extended catalog / marketing text builder / installment calculator.

Covers the six critical business paths:
  1. Marketing text: empty optional fields are skipped
  2. Marketing text: full spec renders every block
  3. Calculator: standard flow with 6 tiers
  4. Calculator: negative ariza clamps to 0
  5. Installment tiers seeded by migration 0004
  6. MarketingSettings singleton behaviour
"""

from __future__ import annotations

from decimal import Decimal

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from apps.catalog.models import (
    InstallmentTier,
    MarketingSettings,
    PhoneModel,
)
from apps.catalog.quote_builder import build_marketing_text
from apps.catalog.services import calculate_installments
from apps.operators.models import Operator
from apps.users.models import Profile, Role

User = get_user_model()

pytestmark = pytest.mark.django_db


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def manager_user(db):
    user = User.objects.create_user(username="mgr_catalog_ext", password="x")
    Profile.objects.create(user=user, role=Role.MANAGER)
    return user


@pytest.fixture
def operator_user(db):
    op = Operator.objects.create(full_name="Op ext catalog", status="active")
    user = User.objects.create_user(username="op_catalog_ext", password="x")
    Profile.objects.create(user=user, role=Role.OPERATOR, operator=op)
    return user


@pytest.fixture
def api_client():
    return APIClient()


@pytest.fixture
def full_phone(db):
    """Honor X8D–style rich phone with every optional field populated."""
    return PhoneModel.objects.create(
        brand="Honor",
        model_name="X8D",
        storage_gb=256,
        ram_gb=8,
        price=Decimal("3599000.00"),
        tagline="Yuqori sifat va yuqori mustahkamlik!",
        camera_mp=108,
        battery_mah=7000,
        specs_json={"processor": "Snapdragon 6 Gen 1", "screen": "6.7 AMOLED"},
        is_active=True,
        stock_status="available",
    )


@pytest.fixture
def bare_phone(db):
    """Phone with only mandatory fields — every optional block must be dropped."""
    return PhoneModel.objects.create(
        brand="Nokia",
        model_name="105",
        price=Decimal("250000.00"),
        is_active=True,
        stock_status="available",
    )


# ---------------------------------------------------------------------------
# 1) Migration seeded 6 installment tiers
# ---------------------------------------------------------------------------


def test_installment_tiers_seeded():
    """Migration 0004 must produce exactly the 6 tiers expected by the
    marketing template and the /calculator grid."""
    months = list(
        InstallmentTier.objects.values_list("months", flat=True).order_by("months")
    )
    assert months == [1, 3, 6, 9, 12, 15]

    show = list(
        InstallmentTier.objects.filter(show_in_marketing=True)
        .values_list("months", flat=True)
        .order_by("months")
    )
    assert show == [6, 12, 15], (
        "Only 6/12/15-month tiers should appear in the marketing block by default"
    )

    # Percents match the spec
    pcts = dict(
        InstallmentTier.objects.values_list("months", "commission_pct")
    )
    assert pcts[1] == Decimal("7.00")
    assert pcts[15] == Decimal("50.00")


# ---------------------------------------------------------------------------
# 2) MarketingSettings singleton — .load() creates + reuses
# ---------------------------------------------------------------------------


def test_marketing_settings_singleton_load():
    a = MarketingSettings.load()
    b = MarketingSettings.load()
    assert a.pk == 1 and b.pk == 1
    # Migration 0004 pre-fills defaults so an already-migrated fixture DB
    # returns the seeded phone/telegram/address, not blank strings.
    assert "@naff_ss" in a.telegram_handle


# ---------------------------------------------------------------------------
# 3) Marketing text — full phone renders all sections
# ---------------------------------------------------------------------------


def test_marketing_text_full_phone(full_phone):
    text = build_marketing_text(full_phone, language="uz")
    # Header
    assert "Honor X8D" in text
    assert "Yuqori sifat" in text
    # Specs
    assert "108 MP" in text
    assert "8/256 GB" in text
    assert "7000 mAh" in text
    assert "processor: Snapdragon 6 Gen 1" in text
    # Installments block
    assert "Muddatli to'lovga" in text or "Muddatli" in text
    # Contacts (seeded defaults from migration 0004)
    assert "+998 88 750 20 53" in text
    assert "@naff_ss" in text
    assert "Yunusobod" in text


# ---------------------------------------------------------------------------
# 4) Marketing text — bare phone skips every optional block
# ---------------------------------------------------------------------------


def test_marketing_text_bare_phone_skips_empty(bare_phone):
    text = build_marketing_text(bare_phone, language="uz")
    assert "Nokia 105" in text
    # No camera / battery / RAM / storage → no spec lines with those emojis
    assert "MP" not in text  # no camera line
    assert "mAh" not in text
    # But the settings-seeded contacts still render
    assert "+998 88 750 20 53" in text
    # And installments section should still render because tiers use price
    assert "Muddatli" in text or "Rassrochka" in text or "Bo'lib" in text or "oy" in text


# ---------------------------------------------------------------------------
# 5) Calculator — standard case
# ---------------------------------------------------------------------------


def test_calculate_installments_basic():
    """Amount 10 000 000 − down 2 000 000 → ariza 8 000 000; check the
    12-month tier @ 38%: total = 8M × 1.38 = 11 040 000, monthly = 920 000."""
    payload = calculate_installments(
        amount=Decimal("10000000"),
        down_payment=Decimal("2000000"),
    )
    assert payload["ariza"] == "8000000.00"
    row_12m = next(r for r in payload["tiers"] if r["months"] == 12)
    assert row_12m["commission_pct"] == "38.00"
    assert row_12m["total"] == "11040000.00"
    assert row_12m["sum_per_month"] == "920000.00"

    # 6 tiers total
    assert len(payload["tiers"]) == 6


# ---------------------------------------------------------------------------
# 6) Calculator — down > amount clamps ariza to 0
# ---------------------------------------------------------------------------


def test_calculate_installments_negative_ariza_clamped():
    payload = calculate_installments(
        amount=Decimal("500000"),
        down_payment=Decimal("2000000"),
    )
    assert payload["ariza"] == "0.00"
    # Every tier row should compute to zero — nothing to finance.
    for row in payload["tiers"]:
        assert row["ariza_narxi"] == "0.00"
        assert row["komissiya_sum"] == "0.00"
        assert row["sum_per_month"] == "0.00"


# ---------------------------------------------------------------------------
# Bonus — API smoke: calculator + marketing endpoints round-trip
# ---------------------------------------------------------------------------


def test_calculator_api_operator_can_call(api_client, operator_user, full_phone):
    api_client.force_authenticate(operator_user)
    r = api_client.post(
        "/api/catalog/calculate/",
        {"amount": "3599000", "down_payment": "0", "phone_id": full_phone.id},
        format="json",
    )
    assert r.status_code == 200, r.data
    assert r.data["ariza"] == "3599000.00"
    assert len(r.data["tiers"]) == 6
    assert r.data["phone"]["model_name"] == "X8D"


def test_marketing_text_api_operator_can_call(api_client, operator_user, full_phone):
    api_client.force_authenticate(operator_user)
    r = api_client.get(f"/api/catalog/phones/{full_phone.id}/marketing/?lang=uz")
    assert r.status_code == 200, r.data
    assert "Honor X8D" in r.data["text"]
    assert r.data["lang"] == "uz"


def test_marketing_settings_manager_can_patch(api_client, manager_user):
    api_client.force_authenticate(manager_user)
    r = api_client.patch(
        "/api/catalog/marketing-settings/",
        {"telegram_handle": "@naff_ss_new"},
        format="json",
    )
    assert r.status_code == 200, r.data
    assert r.data["telegram_handle"] == "@naff_ss_new"
    assert MarketingSettings.load().telegram_handle == "@naff_ss_new"


def test_marketing_settings_operator_cannot_patch(api_client, operator_user):
    api_client.force_authenticate(operator_user)
    r = api_client.patch(
        "/api/catalog/marketing-settings/",
        {"telegram_handle": "@should_not_change"},
        format="json",
    )
    assert r.status_code == 403


def test_installment_tier_operator_can_list_but_not_write(
    api_client, operator_user, full_phone
):
    api_client.force_authenticate(operator_user)
    r = api_client.get("/api/catalog/installment-tiers/")
    assert r.status_code == 200, r.data
    r2 = api_client.post(
        "/api/catalog/installment-tiers/",
        {"months": 24, "commission_pct": "60"},
        format="json",
    )
    assert r2.status_code == 403


def test_manager_can_create_phone_regression(api_client, manager_user):
    """Regression guard: after relaxing catalog CRUD from IsTeamLead to
    IsManager, a plain manager (not team_lead) must be able to add a phone."""
    api_client.force_authenticate(manager_user)
    r = api_client.post(
        "/api/catalog/phones/",
        {
            "brand": "Xiaomi",
            "model_name": "Redmi Note 14",
            "price": "3500000.00",
        },
        format="json",
    )
    assert r.status_code == 201, r.data
    assert PhoneModel.objects.filter(model_name="Redmi Note 14").exists()

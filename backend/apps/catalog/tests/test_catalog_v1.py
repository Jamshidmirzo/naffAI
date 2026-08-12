"""
Catalog v1: quote formatting + installment matrix + basic CRUD sanity.
"""

from decimal import Decimal

import pytest

from apps.catalog.models import (
    InstallmentBank,
    InstallmentPlan,
    PhoneColor,
    PhoneModel,
)
from apps.catalog.quote_builder import build_phone_quote, installment_rows


@pytest.fixture
def alif(db):
    bank = InstallmentBank.objects.create(name="Alif", icon="🏦", sort_order=1)
    InstallmentPlan.objects.create(bank=bank, term_months=6, multiplier=Decimal("1.100"))
    InstallmentPlan.objects.create(bank=bank, term_months=12, multiplier=Decimal("1.180"))
    InstallmentPlan.objects.create(bank=bank, term_months=24, multiplier=Decimal("1.350"))
    return bank


@pytest.fixture
def iphone(db, alif):
    p = PhoneModel.objects.create(
        brand="Apple",
        model_name="iPhone 17 Pro Max",
        storage_gb=256,
        ram_gb=8,
        price=Decimal("22500000"),
        description="",
    )
    PhoneColor.objects.create(phone=p, name="Deep Blue", sort_order=1)
    PhoneColor.objects.create(phone=p, name="Silver", sort_order=2)
    return p


@pytest.mark.django_db
def test_installment_matrix_math(iphone, alif):
    rows = installment_rows(iphone)
    # 3 plans, all Alif
    assert len(rows) == 3
    assert all(r["bank"] == "Alif" for r in rows)
    # 6-month plan: 22.5M × 1.10 = 24.75M total; monthly = 4 125 000
    six = next(r for r in rows if r["term_months"] == 6)
    assert six["total"] == Decimal("24750000.00")
    assert six["monthly"] == Decimal("4125000.00")
    assert six["overpay"] == Decimal("2250000.00")


@pytest.mark.django_db
def test_quote_uz_contains_key_pieces(iphone):
    quote = build_phone_quote(iphone, language="uz")
    assert "iPhone 17 Pro Max" in quote
    assert "256GB" in quote
    assert "8GB RAM" in quote
    assert "Deep Blue" in quote
    assert "Silver" in quote
    assert "Narxi" in quote
    assert "22 500 000" in quote
    assert "Alif 6 oy" in quote
    assert "so'm" in quote


@pytest.mark.django_db
def test_quote_ru_contains_ru_labels(iphone):
    quote = build_phone_quote(iphone, language="ru")
    assert "Цена" in quote
    assert "Рассрочка" in quote
    assert "мес" in quote
    assert "сум" in quote


@pytest.mark.django_db
def test_inactive_plan_skipped(iphone, alif):
    # Deactivate 12-month plan → should disappear from matrix.
    alif.plans.filter(term_months=12).update(is_active=False)
    rows = installment_rows(iphone)
    terms = {r["term_months"] for r in rows}
    assert 12 not in terms
    assert 6 in terms
    assert 24 in terms


@pytest.mark.django_db
def test_unavailable_color_skipped_in_quote(iphone):
    iphone.colors.filter(name="Silver").update(is_available=False)
    quote = build_phone_quote(iphone, language="ru")
    assert "Silver" not in quote
    assert "Deep Blue" in quote

"""
Tests for the demand-vs-supply selector added in the 2026-09-07 wave.

Covers:
    * `_norm_model` collapses cyrillic + glue spellings to a common key.
    * `product_demand_vs_supply` groups leads by product_hint, sales by
      phone_model, and returns a full-outer join with the right indicator.
    * `sheet_source_id` filter properly narrows both sides.
    * `marketing_source_breakdown` gains `product_hint_top` and
      `demand_supply_ratio` fields without breaking the pre-existing shape.
"""

from __future__ import annotations

import datetime as dt
from decimal import Decimal

import pytest
from django.utils import timezone

from apps.analytics.selectors import (
    _norm_model,
    marketing_source_breakdown,
    product_demand_vs_supply,
)
from apps.catalog.models import Channel
from apps.leads.models import Lead, LeadSource, LeadStatus, SheetSource
from apps.operators.models import Operator
from apps.sales.models import Sale, SaleOperator


# ---- _norm_model unit -------------------------------------------------


def test_norm_model_cyrillic_and_glue():
    assert _norm_model("iPhone 16 Pro Max") == "iphone 16"
    assert _norm_model("айфон 16") == "iphone 16"
    assert _norm_model("iph 16") == "iphone 16"
    assert _norm_model("iphone16") == "iphone 16"
    assert _norm_model("Samsung A57") == "samsung a57"
    assert _norm_model("самсунг а57") == "samsung а57"  # cyrillic tail kept
    assert _norm_model("Redmi Note 13") == "redmi note"  # tail trimmed to 1
    assert _norm_model("") == ""
    assert _norm_model(None) == ""
    assert _norm_model("iphone pro") == "iphone"  # NOISE token dropped


# ---- Fixtures --------------------------------------------------------


@pytest.fixture
def op(db):
    return Operator.objects.create(
        full_name="Op One", phone="+998900000101", status="active"
    )


@pytest.fixture
def channel(db):
    return Channel.objects.create(name="Cash", is_active=True)


@pytest.fixture
def sheet(db):
    return SheetSource.objects.create(name="TestVideo", spreadsheet_id="ss", gid=1)


@pytest.fixture
def other_sheet(db):
    return SheetSource.objects.create(name="OtherVideo", spreadsheet_id="ss", gid=2)


@pytest.fixture
def window(db):
    now = timezone.now()
    return now - dt.timedelta(days=7), now + dt.timedelta(days=1)


def _make_sale(*, lead, op, channel, amount, model, sold_at=None, sheet_source=None):
    s = Sale.objects.create(
        imei="1",
        phone_model=model,
        operator=op,
        channel=channel,
        amount=Decimal(amount),
        sold_at=sold_at or timezone.now(),
        lead=lead,
        sheet_source=sheet_source or (lead.sheet_source if lead else None),
        status="confirmed",
    )
    SaleOperator.objects.create(sale=s, operator=op, amount=Decimal(amount))
    return s


# ---- product_demand_vs_supply ---------------------------------------


@pytest.mark.django_db
def test_demand_vs_supply_basic(op, channel, sheet, window):
    start, end = window

    # 3 leads want iphone 16, 2 want samsung a57, 1 empty hint.
    Lead.objects.create(sheet_source=sheet, product_hint="iPhone 16 Pro")
    Lead.objects.create(sheet_source=sheet, product_hint="айфон 16")
    l3 = Lead.objects.create(sheet_source=sheet, product_hint="iphone16",
                             status=LeadStatus.WON)
    Lead.objects.create(sheet_source=sheet, product_hint="самсунг a57")
    Lead.objects.create(sheet_source=sheet, product_hint="samsung a57")
    Lead.objects.create(sheet_source=sheet, product_hint="")

    # 2 sales: one iphone 16, one samsung a57
    _make_sale(lead=l3, op=op, channel=channel, amount="5000000",
               model="iPhone 16 Pro Max")
    _make_sale(lead=None, op=op, channel=channel, amount="3000000",
               model="Samsung A57", sheet_source=sheet)

    out = product_demand_vs_supply(date_from=start, date_to=end)

    # Demand: iphone 16 = 3, samsung a57 = 2 (mixed spellings collapse)
    demand_by_key = {r["model_key"]: r["count"] for r in out["demand_top"]}
    assert demand_by_key.get("iphone 16") == 3
    assert demand_by_key.get("samsung a57") == 2

    supply_by_key = {r["model_key"]: r["count"] for r in out["supply_top"]}
    assert supply_by_key.get("iphone 16") == 1
    assert supply_by_key.get("samsung a57") == 1

    gap_by_key = {r["model_key"]: r for r in out["gap"]}
    assert gap_by_key["iphone 16"]["demand_count"] == 3
    assert gap_by_key["iphone 16"]["supply_count"] == 1
    assert gap_by_key["samsung a57"]["demand_count"] == 2


@pytest.mark.django_db
def test_demand_vs_supply_source_filter(op, channel, sheet, other_sheet, window):
    start, end = window

    Lead.objects.create(sheet_source=sheet, product_hint="iphone 15")
    Lead.objects.create(sheet_source=other_sheet, product_hint="iphone 16")

    out_sheet = product_demand_vs_supply(
        source_id=sheet.id, date_from=start, date_to=end
    )
    keys = {r["model_key"] for r in out_sheet["demand_top"]}
    assert "iphone 15" in keys
    assert "iphone 16" not in keys

    out_other = product_demand_vs_supply(
        source_id=other_sheet.id, date_from=start, date_to=end
    )
    keys = {r["model_key"] for r in out_other["demand_top"]}
    assert "iphone 16" in keys
    assert "iphone 15" not in keys


@pytest.mark.django_db
def test_demand_vs_supply_excludes_deleted_and_returned(op, channel, sheet, window):
    start, end = window
    lead = Lead.objects.create(sheet_source=sheet, product_hint="iphone 16")

    good = _make_sale(lead=lead, op=op, channel=channel, amount="1",
                      model="iPhone 16")
    bad_del = _make_sale(lead=None, op=op, channel=channel, amount="1",
                         model="iPhone 16", sheet_source=sheet)
    bad_ret = _make_sale(lead=None, op=op, channel=channel, amount="1",
                         model="iPhone 16", sheet_source=sheet)
    Sale.objects.filter(pk=bad_del.pk).update(is_deleted=True)
    Sale.objects.filter(pk=bad_ret.pk).update(is_returned=True)

    out = product_demand_vs_supply(date_from=start, date_to=end)
    supply = {r["model_key"]: r["count"] for r in out["supply_top"]}
    assert supply["iphone 16"] == 1  # only `good`, not deleted/returned
    assert good.pk  # keep ref


@pytest.mark.django_db
def test_demand_vs_supply_gap_indicator(op, channel, sheet, window):
    start, end = window

    # deficit: 10 leads asking for iphone 17, 0 sales
    for _ in range(10):
        Lead.objects.create(sheet_source=sheet, product_hint="iphone 17")

    # surplus: 10 sales of a model no one asked for
    for _ in range(6):
        _make_sale(lead=None, op=op, channel=channel, amount="1",
                   model="Nokia 105", sheet_source=sheet)

    out = product_demand_vs_supply(date_from=start, date_to=end)
    gap_by_key = {r["model_key"]: r for r in out["gap"]}
    assert gap_by_key["iphone 17"]["indicator"] == "gap_deficit"
    assert gap_by_key["nokia 105"]["indicator"] == "gap_surplus"


# ---- marketing_source_breakdown regression --------------------------


@pytest.mark.django_db
def test_source_breakdown_still_has_legacy_keys(op, channel, sheet, window):
    """Wave-N adds two fields but MUST NOT drop any pre-existing keys —
    `Marketing.tsx` reads all of them via TypeScript types."""
    start, end = window
    lead = Lead.objects.create(
        sheet_source=sheet,
        product_hint="iphone 16",
        status=LeadStatus.WON,
        source=LeadSource.SHEET,
    )
    _make_sale(lead=lead, op=op, channel=channel, amount="5000000",
               model="iPhone 16 Pro")

    rows = marketing_source_breakdown(date_from=start, date_to=end)
    row = next(r for r in rows if r["source_name"] == "TestVideo")
    for key in (
        "source_name", "kind", "leads", "converted", "conv_rate",
        "revenue", "avg_check", "avg_time_to_conv_hours",
        "top_products", "top_operators", "prev_period",
        "delta_pp", "delta_leads", "adspend",
        # Wave-N additions:
        "product_hint_top", "demand_supply_ratio",
    ):
        assert key in row, f"missing {key}"

    # product_hint_top: 1 lead, iphone 16
    assert row["product_hint_top"][0]["model"] == "iphone 16"
    # demand_supply_ratio: the 1 hinted lead's sale matched the hint (100%)
    assert row["demand_supply_ratio"] == 100.0


@pytest.mark.django_db
def test_source_breakdown_demand_supply_ratio_partial(op, channel, sheet, window):
    start, end = window
    # 2 leads asked for iphone 16, one bought iphone 15 (mismatch), other
    # bought iphone 16 (match) → ratio 50 %.
    l1 = Lead.objects.create(sheet_source=sheet, product_hint="iphone 16",
                             status=LeadStatus.WON)
    l2 = Lead.objects.create(sheet_source=sheet, product_hint="iphone 16",
                             status=LeadStatus.WON)
    _make_sale(lead=l1, op=op, channel=channel, amount="1", model="iPhone 15")
    _make_sale(lead=l2, op=op, channel=channel, amount="1", model="iPhone 16")

    rows = marketing_source_breakdown(date_from=start, date_to=end)
    row = next(r for r in rows if r["source_name"] == "TestVideo")
    assert row["demand_supply_ratio"] == 50.0

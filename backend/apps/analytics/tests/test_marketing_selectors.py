"""
Marketing analytics selectors — smoke + basic behaviour tests.

Focus on shape + non-crash correctness across BOT/MANUAL/SHEET sources.
Precise financial invariants (net revenue, credit split) are covered by
the sales/analytics test suites elsewhere.
"""

from __future__ import annotations

import datetime as dt
from decimal import Decimal

import pytest
from django.utils import timezone

from apps.analytics.selectors import (
    channel_source_matrix,
    cohort_conversion,
    funnel_by_source,
    marketing_source_breakdown,
    marketing_totals,
    rejection_reasons_by_source,
    time_pattern_by_source,
    wow_delta,
)
from apps.catalog.models import Channel
from apps.leads.models import Lead, LeadSource, LeadStatus, SheetSource
from apps.operators.models import Operator
from apps.sales.models import Sale, SaleOperator, SalePartner


@pytest.fixture
def op(db):
    return Operator.objects.create(full_name="Op One", phone="+998900000001", status="active")


@pytest.fixture
def channel(db):
    return Channel.objects.create(name="Cash", is_active=True)


@pytest.fixture
def sheet(db):
    return SheetSource.objects.create(name="Instagram_Q3", spreadsheet_id="ss", gid=100)


@pytest.fixture
def window(db):
    # Wide window (yesterday..tomorrow) — deliberately generous so tests
    # don't race with the second-boundary at which the fixture is created
    # vs. leads/sales created inside the test body.
    now = timezone.now()
    end = now + dt.timedelta(days=1)
    start = now - dt.timedelta(days=7)
    return start, end


def _make_sale(*, lead, op, channel, amount="5000000", sold_at=None, sheet_source=None):
    """Helper: create a confirmed sale allocated to `op`, paid by `channel`."""
    s = Sale.objects.create(
        imei="123",
        phone_model="iPhone 15",
        operator=op,
        channel=channel,
        amount=Decimal(amount),
        sold_at=sold_at or timezone.now(),
        lead=lead,
        sheet_source=sheet_source or lead.sheet_source if lead else None,
        status="confirmed",
    )
    SaleOperator.objects.create(sale=s, operator=op, amount=Decimal(amount))
    SalePartner.objects.create(sale=s, partner=channel, amount=Decimal(amount))
    return s


# ---- marketing_source_breakdown --------------------------------------


@pytest.mark.django_db
def test_source_breakdown_includes_bot_and_manual(op, channel, sheet, window):
    start, end = window
    now = timezone.now()

    l1 = Lead.objects.create(sheet_source=sheet, status=LeadStatus.WON, source=LeadSource.SHEET)
    l2 = Lead.objects.create(sheet_source=sheet, status=LeadStatus.NEW, source=LeadSource.SHEET)
    l3 = Lead.objects.create(status=LeadStatus.WON, source=LeadSource.BOT)
    l4 = Lead.objects.create(status=LeadStatus.NEW, source=LeadSource.MANUAL)

    _make_sale(lead=l1, op=op, channel=channel, amount="5000000", sold_at=now)
    _make_sale(lead=l3, op=op, channel=channel, amount="8000000", sold_at=now)

    rows = marketing_source_breakdown(date_from=start, date_to=end)
    labels = {r["source_name"] for r in rows}
    assert "Instagram_Q3" in labels
    assert "Telegram-бот" in labels
    assert "Ручной ввод" in labels

    insta = next(r for r in rows if r["source_name"] == "Instagram_Q3")
    assert insta["leads"] == 2
    assert insta["converted"] == 1
    assert insta["conv_rate"] == 50.0

    bot = next(r for r in rows if r["source_name"] == "Telegram-бот")
    assert bot["leads"] == 1
    assert bot["converted"] == 1
    assert bot["kind"] == "bot"


@pytest.mark.django_db
def test_source_breakdown_avg_time_to_conv(op, channel, sheet, window):
    start, end = window
    now = timezone.now()
    lead = Lead.objects.create(sheet_source=sheet, status=LeadStatus.WON)
    # Manually set created_at to 5 h ago
    Lead.objects.filter(pk=lead.pk).update(created_at=now - dt.timedelta(hours=5))
    lead.refresh_from_db()
    _make_sale(lead=lead, op=op, channel=channel, amount="4000000", sold_at=now)

    rows = marketing_source_breakdown(date_from=start, date_to=end)
    row = next(r for r in rows if r["source_name"] == "Instagram_Q3")
    assert row["avg_time_to_conv_hours"] is not None
    assert 4 <= row["avg_time_to_conv_hours"] <= 6


# ---- funnel_by_source ------------------------------------------------


@pytest.mark.django_db
def test_funnel_by_source_stages(op, sheet, window):
    start, end = window
    Lead.objects.create(sheet_source=sheet, status=LeadStatus.NEW)
    Lead.objects.create(sheet_source=sheet, status=LeadStatus.ASSIGNED)
    Lead.objects.create(sheet_source=sheet, status=LeadStatus.WON)
    Lead.objects.create(sheet_source=sheet, status=LeadStatus.LOST)

    rows = funnel_by_source(date_from=start, date_to=end)
    row = next(r for r in rows if r["source_name"] == "Instagram_Q3")
    assert row["new"] == 1
    assert row["assigned"] == 1
    assert row["won"] == 1
    assert row["lost"] == 1
    assert row["total"] == 4
    assert row["won_pct"] == 25.0


# ---- time_pattern_by_source ------------------------------------------


@pytest.mark.django_db
def test_time_pattern_shape(sheet, window):
    start, end = window
    Lead.objects.create(sheet_source=sheet, status=LeadStatus.NEW)

    out = time_pattern_by_source(date_from=start, date_to=end)
    assert "sources" in out
    assert isinstance(out["sources"], list)
    all_row = next(x for x in out["sources"] if x["source_name"] == "Все источники")
    assert len(all_row["hours"]) == 24
    for h in all_row["hours"]:
        assert set(h.keys()) == {"hour", "leads", "sales"}


# ---- rejection_reasons_by_source -------------------------------------


@pytest.mark.django_db
def test_rejection_reasons_include_postpone_and_sale_rejects(op, channel, sheet, window):
    start, end = window
    now = timezone.now()

    Lead.objects.create(
        sheet_source=sheet, status=LeadStatus.LOST,
        postpone_reason="дорого",
    )
    Lead.objects.create(
        sheet_source=sheet, status=LeadStatus.LOST,
        postpone_reason="дорого",
    )
    Lead.objects.create(
        sheet_source=sheet, status=LeadStatus.LOST,
        postpone_reason="передумал",
    )
    # rejected sale
    Sale.objects.create(
        imei="1", phone_model="iP", operator=op, channel=channel,
        amount=Decimal("1000000"), sold_at=now, status="rejected",
        sheet_source=sheet, rejection_reason="нет договора",
    )

    rows = rejection_reasons_by_source(date_from=start, date_to=end)
    insta = next(r for r in rows if r["source_name"] == "Instagram_Q3")
    reasons = {r["text"]: r["count"] for r in insta["reasons"]}
    assert reasons["дорого"] == 2
    assert reasons["передумал"] == 1
    assert reasons["нет договора"] == 1


# ---- wow_delta -------------------------------------------------------


@pytest.mark.django_db
def test_wow_delta_shape(op, channel, sheet, window):
    start, end = window
    now = timezone.now()
    lead = Lead.objects.create(sheet_source=sheet, status=LeadStatus.WON)
    _make_sale(lead=lead, op=op, channel=channel, amount="3000000", sold_at=now)

    out = wow_delta(date_from=start, date_to=end)
    assert "current" in out and "previous" in out and "delta" in out
    assert out["current"]["leads"] >= 1
    assert out["current"]["converted"] >= 1


# ---- channel_source_matrix ------------------------------------------


@pytest.mark.django_db
def test_channel_source_matrix_shape(op, channel, sheet, window):
    start, end = window
    now = timezone.now()
    lead = Lead.objects.create(sheet_source=sheet, status=LeadStatus.WON)
    _make_sale(lead=lead, op=op, channel=channel, amount="5000000", sold_at=now)

    rows = channel_source_matrix(date_from=start, date_to=end)
    assert len(rows) >= 1
    for r in rows:
        assert "source_name" in r and "channels" in r


# ---- cohort_conversion -----------------------------------------------


@pytest.mark.django_db
def test_cohort_conversion_shape(sheet):
    Lead.objects.create(sheet_source=sheet, status=LeadStatus.NEW)
    out = cohort_conversion(weeks_back=4)
    assert isinstance(out, list)
    if out:
        row = out[-1]
        assert "week" in row and "leads_count" in row
        assert "conv_rate_7d" in row and "conv_rate_30d" in row


# ---- marketing_totals -----------------------------------------------


@pytest.mark.django_db
def test_marketing_totals_shape(op, channel, sheet, window):
    start, end = window
    now = timezone.now()
    lead = Lead.objects.create(sheet_source=sheet, status=LeadStatus.WON)
    _make_sale(lead=lead, op=op, channel=channel, amount="7000000", sold_at=now)

    out = marketing_totals(date_from=start, date_to=end)
    for k in ("leads", "converted", "conv_rate", "sales_count", "revenue", "avg_check"):
        assert k in out
    assert out["leads"] >= 1
    assert out["converted"] >= 1

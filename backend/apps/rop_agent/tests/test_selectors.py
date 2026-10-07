"""
Selector smoke tests. Minimal fixtures — the goal is to prove the queries
run without exceptions on an empty DB and produce the expected zero shape,
plus one happy-path that returns real numbers.
"""

from __future__ import annotations

from datetime import timedelta
from decimal import Decimal

import pytest
from django.utils import timezone

from apps.calls.models import CallAttempt, CallOutcome
from apps.catalog.models import Channel
from apps.leads.models import Lead, LeadStatus
from apps.operators.models import Operator
from apps.rop_agent import selectors
from apps.sales.models import Sale, SalePartner, SaleStatus


def _make_lead(*, created_at=None, **fields):
    """Create a Lead and force ``created_at`` past ``auto_now_add``.

    ``TimestampedModel.created_at`` is ``auto_now_add=True`` so Django
    discards any value passed to ``.create``. The post-save ``.update``
    bypasses the auto-stamp.
    """
    l = Lead.objects.create(**fields)
    if created_at is not None:
        Lead.objects.filter(pk=l.pk).update(created_at=created_at)
        l.refresh_from_db(fields=["created_at"])
    return l


@pytest.fixture
def channel(db):
    return Channel.objects.create(name="Telegram")


@pytest.fixture
def partner(db):
    return Channel.objects.create(name="Alif")


@pytest.fixture
def operator(db):
    return Operator.objects.create(full_name="Op One", status="active")


@pytest.mark.django_db
def test_window_kpi_empty_db():
    today = selectors.today_tz()
    start, end = selectors.day_bounds(today)
    out = selectors.window_kpi(start, end, label="bugun")
    assert out["leads_created"] == 0
    assert out["leads_contacted"] == 0
    assert out["sales_count"] == 0
    assert out["sales_amount"] == 0.0
    assert out["conv"] == 0.0
    assert out["partner_split"] == []


@pytest.mark.django_db
def test_sales_aggregate_counts_confirmed_only(operator, channel, partner):
    now = timezone.now()
    confirmed = Sale.objects.create(
        imei="123456789012345",
        phone_model="iPhone 15",
        operator=operator,
        channel=channel,
        amount=Decimal("5000000"),
        sold_at=now,
        status=SaleStatus.CONFIRMED,
    )
    SalePartner.objects.create(sale=confirmed, partner=partner, amount=Decimal("5000000"))
    Sale.objects.create(
        imei="999999999999999",
        phone_model="iPhone 14",
        operator=operator,
        channel=channel,
        amount=Decimal("1000000"),
        sold_at=now,
        status=SaleStatus.REJECTED,
    )
    start = now - timedelta(hours=1)
    end = now + timedelta(hours=1)
    agg = selectors.sales_aggregate(start, end)
    assert agg["count"] == 1
    assert agg["amount_sum"] == 5000000.0
    assert agg["amount_avg"] == 5000000.0

    split = selectors.partner_split(start, end)
    assert len(split) == 1
    assert split[0]["channel"] == "Alif"
    assert split[0]["pct"] == 100.0


@pytest.mark.django_db
def test_qimmatli_waiting_filters_by_hot_until(operator):
    now = timezone.now()
    # Not qimmatli — hot_until is None.
    _make_lead(status=LeadStatus.NEW, created_at=now - timedelta(hours=1))
    # Qimmatli, waiting over 2h, SLA still active.
    _make_lead(
        status=LeadStatus.NEW,
        hot_until=now + timedelta(minutes=30),
        created_at=now - timedelta(hours=3),
    )
    # Qimmatli, status WON — must be excluded.
    _make_lead(
        status=LeadStatus.WON,
        hot_until=now + timedelta(minutes=30),
        created_at=now - timedelta(hours=3),
    )
    rows = selectors.qimmatli_waiting_now(min_wait_minutes=60)
    assert len(rows) == 1
    assert rows[0]["wait_minutes"] >= 60


@pytest.mark.django_db
def test_leads_waiting_over_excludes_called(operator):
    now = timezone.now()
    old = _make_lead(status=LeadStatus.NEW, created_at=now - timedelta(hours=2))
    # Called → should NOT be counted
    CallAttempt.objects.create(lead=old, operator=operator, outcome=CallOutcome.NO_ANSWER)
    # Another untouched old lead
    _make_lead(status=LeadStatus.NEW, created_at=now - timedelta(hours=2))
    assert selectors.leads_waiting_over(minutes=30) == 1

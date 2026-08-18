"""
Smoke tests for the manager «Сводка дня» dashboard-summary selector.

Focus on shape + happy-path numeric correctness. Verifies:
  - all keys are present and typed as documented
  - `today.count` counts only confirmed sales in the current calendar day
  - `today.pending_count` counts only pending sales
  - `turnover.actual` is net of discounts, and hits the SalesTarget target
    when one exists for the current period
  - `timeseries` is padded to 14 items (last 14 calendar days incl. today)
  - `attention.orphans` reflects the Lead.orphan_leads() selector
"""
from __future__ import annotations

import datetime as dt
from decimal import Decimal

import pytest
from django.utils import timezone

from apps.analytics.models import SalesTarget, SalesTargetPeriod
from apps.analytics.selectors import dashboard_summary
from apps.catalog.models import Channel
from apps.leads.models import Lead, LeadStatus
from apps.operators.models import Operator, OperatorStatus
from apps.sales.models import Sale


@pytest.fixture
def op(db):
    return Operator.objects.create(
        full_name="Bonu Test", phone="+998900000090", status=OperatorStatus.ACTIVE
    )


@pytest.fixture
def channel(db):
    return Channel.objects.create(name="Telegram")


def _mk_sale(*, amount, operator, channel, status="confirmed", is_returned=False, is_deleted=False, sold_at=None):
    """Bypass sale_create service — we test selector aggregation, not the
    write path. We can insert Sale rows directly with the minimum fields."""
    return Sale.objects.create(
        imei="490154203237518",
        phone_model="Test 13",
        operator=operator,
        channel=channel,
        amount=Decimal(str(amount)),
        discount=Decimal("0"),
        sold_at=sold_at or timezone.now(),
        status=status,
        is_returned=is_returned,
        is_deleted=is_deleted,
    )


@pytest.mark.django_db
def test_dashboard_summary_shape_all_keys_present(op, channel):
    """Empty DB should still return the full schema with zero values."""
    resp = dashboard_summary(period="week")

    assert set(resp.keys()) == {
        "period",
        "today",
        "turnover",
        "conversion",
        "shift",
        "timeseries",
        "target_daily_count",
        "attention",
        "top_operators",
    }
    assert resp["period"] == "week"

    for k in ("count", "total", "pending_count"):
        assert k in resp["today"]
    for k in ("actual", "target", "target_period"):
        assert k in resp["turnover"]
    for k in ("value_pct", "delta_pp", "prev_value_pct"):
        assert k in resp["conversion"]
    for k in ("on_shift", "expected", "late_today"):
        assert k in resp["shift"]
    for k in ("to_review", "orphans", "on_review", "late_today"):
        assert k in resp["attention"]

    # timeseries is padded to 14 days (last 14 including today).
    assert len(resp["timeseries"]) == 14
    for row in resp["timeseries"]:
        assert set(row.keys()) == {"day", "count", "total"}

    assert isinstance(resp["top_operators"], list)


@pytest.mark.django_db
def test_dashboard_summary_today_counts_confirmed_only(op, channel):
    _mk_sale(amount=1_000_000, operator=op, channel=channel, status="confirmed")
    _mk_sale(amount=2_000_000, operator=op, channel=channel, status="confirmed")
    _mk_sale(amount=3_000_000, operator=op, channel=channel, status="pending")
    _mk_sale(amount=4_000_000, operator=op, channel=channel, status="confirmed", is_returned=True)  # excluded
    _mk_sale(amount=5_000_000, operator=op, channel=channel, status="confirmed", is_deleted=True)  # excluded

    resp = dashboard_summary(period="day")

    # 2 confirmed × today, 1 pending → today.count = 2, pending_count = 1
    assert resp["today"]["count"] == 2
    assert resp["today"]["pending_count"] == 1
    # turnover: net sum of the 2 confirmed (3 000 000 total)
    assert Decimal(resp["today"]["total"]) == Decimal("3000000")
    assert Decimal(resp["turnover"]["actual"]) == Decimal("3000000")
    # attention: to_review / on_review reflect pending count
    assert resp["attention"]["to_review"] == 1
    assert resp["attention"]["on_review"] == 1


@pytest.mark.django_db
def test_dashboard_summary_returns_current_week_target_if_present():
    """Тест обновляет seed-таргет (мигрируется автоматически) до
    удобных значений и проверяет, что endpoint их отражает."""
    monday = (timezone.now().date()
              - dt.timedelta(days=timezone.now().date().weekday()))
    SalesTarget.objects.update_or_create(
        period_type=SalesTargetPeriod.WEEKLY,
        period_start=monday,
        defaults={
            "target_amount": Decimal("140000000"),
            "target_count": 126,  # 18/day × 7
        },
    )

    resp = dashboard_summary(period="week")

    assert resp["turnover"]["target"] == "140000000.00"
    assert resp["turnover"]["target_period"] == "weekly"
    # target_daily_count = round(126 / 7) = 18
    assert resp["target_daily_count"] == 18


@pytest.mark.django_db
def test_dashboard_summary_target_null_when_no_row_present():
    """Убираем весь seed-набор и подтверждаем, что endpoint не падает."""
    SalesTarget.objects.all().delete()
    resp = dashboard_summary(period="month")
    assert resp["turnover"]["target"] is None
    assert resp["target_daily_count"] is None


@pytest.mark.django_db
def test_dashboard_summary_orphans_count_matches_selector():
    # Two "orphan" leads (no operator, no needs_review, no phone_invalid,
    # active status) and one assigned lead (excluded).
    op = Operator.objects.create(
        full_name="Handled Ops", phone="+998900000091", status=OperatorStatus.ACTIVE
    )
    Lead.objects.create(status=LeadStatus.NEW, phone="+998900000101")
    Lead.objects.create(status=LeadStatus.NEW, phone="+998900000102")
    Lead.objects.create(status=LeadStatus.NEW, phone="+998900000103", operator=op)

    resp = dashboard_summary(period="week")

    assert resp["attention"]["orphans"] == 2


@pytest.mark.django_db
def test_dashboard_summary_falls_back_to_week_for_unknown_period():
    resp = dashboard_summary(period="year")  # unsupported → fallback to week
    assert resp["period"] == "week"

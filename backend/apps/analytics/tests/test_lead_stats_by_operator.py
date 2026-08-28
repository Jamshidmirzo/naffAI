"""
Unit tests for the touched-leads semantics of `lead_stats_snapshot.by_operator`.

Bug fix 2026-08-28: user picked "Yesterday" preset — chart moved, but the
`total/won/lost/in_progress` columns in the by_operator table stuck on zero
because they used `Lead.created_at` while `calls_total` used
`CallAttempt.created_at`. Two different universes. Now all 4 counters follow
the SAME universe: "leads this operator TOUCHED (made ≥1 call) in the
period". Sales are unchanged (independent metric).
"""
from __future__ import annotations

import datetime as dt

import pytest
from django.utils import timezone

from apps.analytics.selectors import lead_stats_snapshot
from apps.calls.models import CallAttempt, CallOutcome
from apps.leads.models import Lead, LeadStatus
from apps.operators.models import Operator, OperatorStatus


def _window_today() -> tuple[dt.datetime, dt.datetime]:
    """[today 00:00 … today 23:59:59.999] in the active TZ."""
    tz = timezone.get_current_timezone()
    today = timezone.localdate()
    start = dt.datetime.combine(today, dt.time.min, tzinfo=tz)
    end = dt.datetime.combine(today, dt.time.max, tzinfo=tz)
    return start, end


@pytest.fixture
def op_a(db):
    return Operator.objects.create(full_name="Alice", status=OperatorStatus.ACTIVE)


@pytest.fixture
def op_b(db):
    return Operator.objects.create(full_name="Bob", status=OperatorStatus.ACTIVE)


@pytest.mark.django_db
def test_operator_touching_old_leads_counted():
    """
    Regression: operator called leads that were CREATED before the window
    but touched in-window → total must equal number of distinct touched
    leads (not 0, as the old semantics returned).
    """
    op = Operator.objects.create(full_name="Alice", status=OperatorStatus.ACTIVE)

    old_ts = timezone.now() - dt.timedelta(days=30)
    # 3 old leads created 30 days ago.
    old_leads = [
        Lead.objects.create(full_name=f"L{i}", status=LeadStatus.NEW) for i in range(3)
    ]
    # Poke created_at into the past — bypasses auto_now_add.
    Lead.objects.filter(id__in=[l.id for l in old_leads]).update(created_at=old_ts)

    # Alice calls all 3 today.
    for lead in old_leads:
        CallAttempt.objects.create(
            lead=lead, operator=op, outcome=CallOutcome.NO_ANSWER
        )

    date_from, date_to = _window_today()
    snap = lead_stats_snapshot(date_from=date_from, date_to=date_to)
    row = next(r for r in snap["by_operator"] if r["operator_id"] == op.id)

    # 3 distinct touched leads → total=3, calls_total=3, unique=3.
    assert row["total"] == 3
    assert row["calls_total"] == 3
    assert row["unique_leads_touched"] == 3


@pytest.mark.django_db
def test_multiple_calls_same_lead_counted_once_in_total(op_a):
    """One lead + 5 attempts → total=1 (distinct), calls_total=5."""
    lead = Lead.objects.create(full_name="L", status=LeadStatus.NEW)
    for _ in range(5):
        CallAttempt.objects.create(
            lead=lead, operator=op_a, outcome=CallOutcome.NO_ANSWER
        )

    date_from, date_to = _window_today()
    snap = lead_stats_snapshot(date_from=date_from, date_to=date_to)
    row = next(r for r in snap["by_operator"] if r["operator_id"] == op_a.id)

    assert row["total"] == 1
    assert row["calls_total"] == 5
    assert row["unique_leads_touched"] == 1


@pytest.mark.django_db
def test_won_lost_in_progress_split_by_current_status(op_a):
    """
    Given 4 touched leads with statuses [won, lost, archived, new]:
      won=1, lost=1, archived stays out of in_progress, in_progress=1 (only new)
    """
    won = Lead.objects.create(full_name="W", status=LeadStatus.WON)
    lost = Lead.objects.create(full_name="LOST", status=LeadStatus.LOST)
    arch = Lead.objects.create(full_name="A", status=LeadStatus.ARCHIVED)
    new = Lead.objects.create(full_name="N", status=LeadStatus.NEW)
    for lead in (won, lost, arch, new):
        CallAttempt.objects.create(
            lead=lead, operator=op_a, outcome=CallOutcome.NO_ANSWER
        )

    date_from, date_to = _window_today()
    snap = lead_stats_snapshot(date_from=date_from, date_to=date_to)
    row = next(r for r in snap["by_operator"] if r["operator_id"] == op_a.id)

    assert row["total"] == 4
    assert row["won"] == 1
    assert row["lost"] == 1
    # archived is neither won/lost nor in_progress: total - won - lost - arch = 4-1-1-1=1
    assert row["in_progress"] == 1
    # 1 won of 4 touched → 25.0%
    assert row["conversion_pct"] == 25.0


@pytest.mark.django_db
def test_operator_with_no_calls_does_not_appear(op_a, op_b):
    """
    Alice touched a lead; Bob didn't. Bob has no sales either → Bob must
    not be in by_operator (touched-leads semantics excludes idle operators).
    """
    lead = Lead.objects.create(full_name="L", status=LeadStatus.NEW)
    CallAttempt.objects.create(lead=lead, operator=op_a, outcome=CallOutcome.NO_ANSWER)

    date_from, date_to = _window_today()
    snap = lead_stats_snapshot(date_from=date_from, date_to=date_to)
    op_ids = {r["operator_id"] for r in snap["by_operator"]}

    assert op_a.id in op_ids
    assert op_b.id not in op_ids


@pytest.mark.django_db
def test_operator_with_only_sale_still_appears():
    """
    "Dostik case": operator has confirmed sales in the period but ZERO
    calls / touched leads → row must still appear (sold_total>0), with
    total=0. Preserves the pre-existing safety net.
    """
    from decimal import Decimal

    from apps.catalog.models import Channel
    from apps.sales.models import Sale, SaleOperator

    dostik = Operator.objects.create(full_name="Dostik", status=OperatorStatus.ACTIVE)
    channel = Channel.objects.create(name="Walk-in", is_active=True)

    now = timezone.now()
    sale = Sale.objects.create(
        imei="490154203237518",  # Luhn-valid
        phone_model="Test",
        channel=channel,
        amount=Decimal("1000000"),
        discount=Decimal("0"),
        sold_at=now,
        status="confirmed",
    )
    SaleOperator.objects.create(sale=sale, operator=dostik, amount=Decimal("1000000"))

    date_from, date_to = _window_today()
    snap = lead_stats_snapshot(date_from=date_from, date_to=date_to)
    row = next((r for r in snap["by_operator"] if r["operator_id"] == dostik.id), None)

    assert row is not None
    assert row["sold_total"] == 1
    assert row["total"] == 0
    assert row["calls_total"] == 0


@pytest.mark.django_db
def test_out_of_window_calls_ignored(op_a):
    """
    Alice called yesterday's leads yesterday; today's snapshot should not
    count them. Confirms `created_at__gte / lte` boundary is respected.
    """
    old_lead = Lead.objects.create(full_name="OL", status=LeadStatus.NEW)
    attempt = CallAttempt.objects.create(
        lead=old_lead, operator=op_a, outcome=CallOutcome.NO_ANSWER
    )
    # Move the attempt back 3 days.
    CallAttempt.objects.filter(id=attempt.id).update(
        created_at=timezone.now() - dt.timedelta(days=3)
    )

    date_from, date_to = _window_today()
    snap = lead_stats_snapshot(date_from=date_from, date_to=date_to)
    row = next((r for r in snap["by_operator"] if r["operator_id"] == op_a.id), None)

    # Alice has no in-window activity → not in the list (no sales either).
    assert row is None


@pytest.mark.django_db
def test_sort_order_touched_desc(op_a, op_b):
    """Sort key: (total, sold_total, calls_total) DESC. Alice touches 3, Bob touches 1."""
    for i in range(3):
        l = Lead.objects.create(full_name=f"A{i}", status=LeadStatus.NEW)
        CallAttempt.objects.create(lead=l, operator=op_a, outcome=CallOutcome.NO_ANSWER)
    l = Lead.objects.create(full_name="B", status=LeadStatus.NEW)
    CallAttempt.objects.create(lead=l, operator=op_b, outcome=CallOutcome.NO_ANSWER)

    date_from, date_to = _window_today()
    snap = lead_stats_snapshot(date_from=date_from, date_to=date_to)

    ordered_ids = [r["operator_id"] for r in snap["by_operator"]]
    assert ordered_ids.index(op_a.id) < ordered_ids.index(op_b.id)

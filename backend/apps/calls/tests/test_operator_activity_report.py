"""
Unit tests for `operator_activity_report()` selector.

Coverage:
- distinct-lead dedup (5 calls / 1 lead = 1 unique lead)
- distribution by *current* Lead.status
- multiple operators produce separate rows
- empty period → all operators show zeros (still rendered)
- operator_ids filter
- validation: date_from > date_to → ValueError
- validation: > 92 days → ValueError
- TZ boundary: attempt at 23:30 Tashkent on day D belongs to D, not D+1
- inactive operators are excluded even if they have calls in the window
"""

from __future__ import annotations

import datetime as dt

import pytest
from django.utils import timezone

from apps.calls.models import CallAttempt, CallOutcome
from apps.calls.selectors import (
    OPERATOR_ACTIVITY_MAX_DAYS,
    operator_activity_report,
)
from apps.leads.models import Lead, LeadStatus
from apps.operators.models import Operator, OperatorStatus


@pytest.fixture
def two_ops(db):
    op_a = Operator.objects.create(full_name="Alice", status=OperatorStatus.ACTIVE)
    op_b = Operator.objects.create(full_name="Bob", status=OperatorStatus.ACTIVE)
    return op_a, op_b


def _call(op: Operator, lead: Lead, *, when: dt.datetime | None = None) -> CallAttempt:
    """Create a CallAttempt with an optional custom created_at (auto_now
    bypass via .filter().update — TimestampedModel.created_at is
    auto_now_add so we can't set it directly on .create())."""
    attempt = CallAttempt.objects.create(
        lead=lead,
        operator=op,
        outcome=CallOutcome.NO_ANSWER,
        comment="",
    )
    if when is not None:
        CallAttempt.objects.filter(pk=attempt.pk).update(created_at=when)
        attempt.refresh_from_db()
    return attempt


@pytest.mark.django_db
def test_distinct_lead_dedup(two_ops):
    """5 attempts on 1 lead → unique_leads_touched=1, calls_total=5."""
    op_a, _ = two_ops
    lead = Lead.objects.create(full_name="Lead1", operator=op_a, status=LeadStatus.NEW)
    today = timezone.localdate()
    now = timezone.now()
    for _ in range(5):
        _call(op_a, lead, when=now)

    report = operator_activity_report(date_from=today, date_to=today)
    row = next(r for r in report["rows"] if r["operator_id"] == op_a.id)
    assert row["unique_leads_touched"] == 1
    assert row["calls_total"] == 5
    assert row["by_status"] == {LeadStatus.NEW: 1}


@pytest.mark.django_db
def test_by_status_distribution(two_ops):
    """Different leads with different current statuses group correctly."""
    op_a, _ = two_ops
    lead1 = Lead.objects.create(full_name="L1", operator=op_a, status=LeadStatus.PHONE_ON)
    lead2 = Lead.objects.create(full_name="L2", operator=op_a, status=LeadStatus.PHONE_ON)
    lead3 = Lead.objects.create(full_name="L3", operator=op_a, status=LeadStatus.NO_ANSWER)
    lead4 = Lead.objects.create(full_name="L4", operator=op_a, status=LeadStatus.WON)
    now = timezone.now()
    for lead in (lead1, lead2, lead3, lead4):
        _call(op_a, lead, when=now)

    today = timezone.localdate()
    report = operator_activity_report(date_from=today, date_to=today)
    row = next(r for r in report["rows"] if r["operator_id"] == op_a.id)
    assert row["unique_leads_touched"] == 4
    assert row["by_status"] == {
        LeadStatus.PHONE_ON: 2,
        LeadStatus.NO_ANSWER: 1,
        LeadStatus.WON: 1,
    }


@pytest.mark.django_db
def test_multiple_operators_separate_rows(two_ops):
    op_a, op_b = two_ops
    lead_a = Lead.objects.create(full_name="LA", operator=op_a, status=LeadStatus.NEW)
    lead_b = Lead.objects.create(full_name="LB", operator=op_b, status=LeadStatus.NEW)
    now = timezone.now()
    _call(op_a, lead_a, when=now)
    _call(op_b, lead_b, when=now)
    _call(op_b, lead_b, when=now)

    today = timezone.localdate()
    report = operator_activity_report(date_from=today, date_to=today)
    row_a = next(r for r in report["rows"] if r["operator_id"] == op_a.id)
    row_b = next(r for r in report["rows"] if r["operator_id"] == op_b.id)
    assert row_a["calls_total"] == 1
    assert row_b["calls_total"] == 2
    # Sorted "who worked more" desc.
    assert report["rows"][0]["operator_id"] == op_b.id


@pytest.mark.django_db
def test_empty_period_returns_zero_rows(two_ops):
    """No calls at all → each operator has zero counters, but the row is present."""
    op_a, op_b = two_ops
    today = timezone.localdate()
    report = operator_activity_report(date_from=today, date_to=today)
    assert len(report["rows"]) == 2
    for row in report["rows"]:
        assert row["calls_total"] == 0
        assert row["unique_leads_touched"] == 0
        assert row["by_status"] == {}


@pytest.mark.django_db
def test_operator_ids_filter(two_ops):
    op_a, op_b = two_ops
    lead_a = Lead.objects.create(full_name="LA", operator=op_a, status=LeadStatus.NEW)
    lead_b = Lead.objects.create(full_name="LB", operator=op_b, status=LeadStatus.NEW)
    now = timezone.now()
    _call(op_a, lead_a, when=now)
    _call(op_b, lead_b, when=now)

    today = timezone.localdate()
    report = operator_activity_report(
        date_from=today, date_to=today, operator_ids=[op_a.id]
    )
    assert len(report["rows"]) == 1
    assert report["rows"][0]["operator_id"] == op_a.id


@pytest.mark.django_db
def test_inactive_operator_excluded(two_ops):
    op_a, op_b = two_ops
    op_b.status = OperatorStatus.INACTIVE
    op_b.save(update_fields=["status"])
    lead_b = Lead.objects.create(full_name="LB", operator=op_b, status=LeadStatus.NEW)
    _call(op_b, lead_b, when=timezone.now())

    today = timezone.localdate()
    report = operator_activity_report(date_from=today, date_to=today)
    assert all(r["operator_id"] != op_b.id for r in report["rows"])


@pytest.mark.django_db
def test_out_of_window_call_excluded(two_ops):
    """Attempt from 5 days ago should not appear in a today-only report."""
    op_a, _ = two_ops
    lead = Lead.objects.create(full_name="L", operator=op_a, status=LeadStatus.NEW)
    stale_when = timezone.now() - dt.timedelta(days=5)
    _call(op_a, lead, when=stale_when)

    today = timezone.localdate()
    report = operator_activity_report(date_from=today, date_to=today)
    row = next(r for r in report["rows"] if r["operator_id"] == op_a.id)
    assert row["calls_total"] == 0
    assert row["by_status"] == {}


@pytest.mark.django_db
def test_tz_boundary_23_30_belongs_to_the_same_local_day(two_ops):
    """
    Attempt at 23:30 Tashkent on day D must be counted in date_from=D,
    date_to=D (not shifted to D+1 by UTC drift).
    """
    op_a, _ = two_ops
    lead = Lead.objects.create(full_name="L", operator=op_a, status=LeadStatus.NEW)
    tz = timezone.get_current_timezone()
    # Use a fixed day comfortably in the past so timezone.localdate() != D.
    d = dt.date(2026, 8, 20)
    local_23_30 = dt.datetime.combine(d, dt.time(23, 30), tzinfo=tz)
    _call(op_a, lead, when=local_23_30)

    # D report: attempt IS in.
    r_d = operator_activity_report(date_from=d, date_to=d)
    row_d = next(r for r in r_d["rows"] if r["operator_id"] == op_a.id)
    assert row_d["calls_total"] == 1
    # D+1 report: attempt is NOT in.
    d_plus = d + dt.timedelta(days=1)
    r_dp1 = operator_activity_report(date_from=d_plus, date_to=d_plus)
    row_dp1 = next(r for r in r_dp1["rows"] if r["operator_id"] == op_a.id)
    assert row_dp1["calls_total"] == 0


@pytest.mark.django_db
def test_date_from_after_date_to_raises(two_ops):
    today = timezone.localdate()
    with pytest.raises(ValueError):
        operator_activity_report(
            date_from=today, date_to=today - dt.timedelta(days=1)
        )


@pytest.mark.django_db
def test_range_too_wide_raises(two_ops):
    today = timezone.localdate()
    too_far = today - dt.timedelta(days=OPERATOR_ACTIVITY_MAX_DAYS + 1)
    with pytest.raises(ValueError):
        operator_activity_report(date_from=too_far, date_to=today)


@pytest.mark.django_db
def test_range_at_limit_ok(two_ops):
    """92-day inclusive window is exactly allowed."""
    today = timezone.localdate()
    boundary = today - dt.timedelta(days=OPERATOR_ACTIVITY_MAX_DAYS - 1)
    report = operator_activity_report(date_from=boundary, date_to=today)
    assert "rows" in report


@pytest.mark.django_db
def test_null_operator_call_is_ignored(two_ops):
    """
    CallAttempt.operator is nullable (operator got deleted). Such rows
    must NOT trigger a phantom None-keyed row in the report.
    """
    op_a, _ = two_ops
    lead = Lead.objects.create(full_name="L", operator=op_a, status=LeadStatus.NEW)
    attempt = _call(op_a, lead, when=timezone.now())
    # Simulate operator deletion side-effect (SET_NULL).
    CallAttempt.objects.filter(pk=attempt.pk).update(operator=None)

    today = timezone.localdate()
    report = operator_activity_report(date_from=today, date_to=today)
    # No operator_id=None row anywhere — the filter operator_id__in=[…]
    # excludes NULL by definition.
    assert all(r["operator_id"] is not None for r in report["rows"])
    row = next(r for r in report["rows"] if r["operator_id"] == op_a.id)
    assert row["calls_total"] == 0

"""
F3.C — extended analytics selectors smoke tests.

Not exhaustive — focuses on shape and non-crash correctness so we know
the aggregations return sane structures. Precise numbers are covered by
the specific selectors that they compose.
"""

from __future__ import annotations

import datetime as dt

import pytest
from django.utils import timezone

from apps.analytics.selectors import (
    callback_hour_heatmap,
    leads_distribution_by_operator,
    operator_funnels,
)
from apps.calls.models import CallAttempt, CallbackReminder
from apps.leads.models import Lead, LeadStatus
from apps.operators.models import Operator


@pytest.fixture
def two_operators(db):
    o1 = Operator.objects.create(full_name="Op One", phone="+998900000011", status="active")
    o2 = Operator.objects.create(full_name="Op Two", phone="+998900000012", status="active")
    return o1, o2


@pytest.mark.django_db
def test_leads_distribution_shape(two_operators):
    o1, o2 = two_operators
    Lead.objects.create(operator=o1, status=LeadStatus.NEW)
    Lead.objects.create(operator=o1, status=LeadStatus.IN_PROGRESS)
    Lead.objects.create(operator=o2, status=LeadStatus.WON)
    Lead.objects.create(status=LeadStatus.NEW)  # unassigned — excluded

    rows = leads_distribution_by_operator()
    ids = {r["operator_id"] for r in rows}
    assert o1.id in ids and o2.id in ids
    o1_row = next(r for r in rows if r["operator_id"] == o1.id)
    assert o1_row["new"] == 1
    assert o1_row["in_progress"] == 1
    assert o1_row["total"] == 2
    o2_row = next(r for r in rows if r["operator_id"] == o2.id)
    assert o2_row["won"] == 1
    # sorted by -total → o1 first (2 > 1)
    assert rows[0]["operator_id"] == o1.id


@pytest.mark.django_db
def test_operator_funnels_returns_top_n(two_operators):
    o1, o2 = two_operators
    lead = Lead.objects.create(operator=o1, status=LeadStatus.WON)
    Lead.objects.create(operator=o1, status=LeadStatus.NEW)
    Lead.objects.create(operator=o2, status=LeadStatus.NEW)

    CallAttempt.objects.create(lead=lead, operator=o1, outcome="talked_interested")
    CallbackReminder.objects.create(
        lead=lead, operator=o1, remind_at=timezone.now() + dt.timedelta(hours=1)
    )

    rows = operator_funnels(top_n=5)
    o1_row = next(r for r in rows if r["operator_id"] == o1.id)
    assert o1_row["leads_total"] == 2
    assert o1_row["contacted"] == 1
    assert o1_row["callbacks"] == 1
    assert o1_row["sales"] == 1


@pytest.mark.django_db
def test_callback_hour_heatmap_shape(two_operators):
    o1, _ = two_operators
    lead = Lead.objects.create(operator=o1, status=LeadStatus.NEW)
    now = timezone.now()
    CallbackReminder.objects.create(lead=lead, operator=o1, remind_at=now)

    data = callback_hour_heatmap(days_back=30)
    assert data["hours"] == list(range(24))
    assert len(data["operators"]) == 1
    assert data["operators"][0]["id"] == o1.id
    assert len(data["matrix"]) == 1
    assert len(data["matrix"][0]) == 24
    # We stored one reminder → the row must sum to at least 1.
    assert sum(data["matrix"][0]) >= 1

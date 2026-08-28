"""
API tests for the merged manager stats endpoint:

  GET /api/analytics/lead-stats/

Covers:
  - backwards compat: ?period=day|week|month keeps working
  - explicit YYYY-MM-DD range with calls activity in `by_operator`
  - validation errors: one-sided range / bad format / from > to / > 92d
  - operator with only calls (no leads, no sales) still shows up
"""
from __future__ import annotations

import datetime as dt

import pytest
from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.utils import timezone
from rest_framework.test import APIClient

from apps.calls.models import CallAttempt, CallOutcome
from apps.leads.models import Lead, LeadStatus
from apps.operators.models import Operator, OperatorStatus
from apps.users.models import Profile, Role

User = get_user_model()


@pytest.fixture(autouse=True)
def _clear_cache():
    """LeadStatsApi memoizes on (date_from, date_to) — clear between tests."""
    cache.clear()
    yield
    cache.clear()


@pytest.fixture
def api_client():
    return APIClient()


@pytest.fixture
def manager(db):
    u = User.objects.create_user(username="mgr", password="x")
    Profile.objects.create(user=u, role=Role.MANAGER)
    return u


@pytest.fixture
def op_a(db):
    return Operator.objects.create(full_name="Alice", status=OperatorStatus.ACTIVE)


@pytest.fixture
def op_b(db):
    return Operator.objects.create(full_name="Bob", status=OperatorStatus.ACTIVE)


def _today() -> str:
    return timezone.localdate().strftime("%Y-%m-%d")


@pytest.mark.django_db
def test_period_legacy_still_works(api_client, manager, op_a):
    """Old FE preset chips (?period=day) still return a valid payload."""
    Lead.objects.create(full_name="L", operator=op_a, status=LeadStatus.NEW)
    api_client.force_authenticate(manager)
    r = api_client.get("/api/analytics/lead-stats/?period=day")
    assert r.status_code == 200
    body = r.json()
    assert "total" in body
    assert "by_status" in body
    assert "by_operator" in body
    assert "daily" in body


@pytest.mark.django_db
def test_ymd_range_returns_calls_and_unique(api_client, manager, op_a):
    """Explicit YYYY-MM-DD range surfaces the new call-activity fields."""
    lead = Lead.objects.create(full_name="L", operator=op_a, status=LeadStatus.NEW)
    CallAttempt.objects.create(lead=lead, operator=op_a, outcome=CallOutcome.NO_ANSWER)
    CallAttempt.objects.create(lead=lead, operator=op_a, outcome=CallOutcome.NO_ANSWER)

    api_client.force_authenticate(manager)
    today = _today()
    r = api_client.get(f"/api/analytics/lead-stats/?date_from={today}&date_to={today}")
    assert r.status_code == 200
    body = r.json()
    row = next(x for x in body["by_operator"] if x["operator_id"] == op_a.id)
    # 2 attempts on 1 lead → calls_total=2, unique=1
    assert row["calls_total"] == 2
    assert row["unique_leads_touched"] == 1


@pytest.mark.django_db
def test_operator_with_only_calls_appears(api_client, manager, op_a, op_b):
    """
    op_b touched a lead via a call but wasn't the lead's operator FK and
    has no sales — must still land in `by_operator`.
    """
    lead = Lead.objects.create(full_name="L", operator=op_a, status=LeadStatus.NEW)
    CallAttempt.objects.create(lead=lead, operator=op_b, outcome=CallOutcome.NO_ANSWER)

    api_client.force_authenticate(manager)
    today = _today()
    r = api_client.get(f"/api/analytics/lead-stats/?date_from={today}&date_to={today}")
    assert r.status_code == 200
    body = r.json()
    op_ids = {x["operator_id"] for x in body["by_operator"]}
    assert op_b.id in op_ids
    row_b = next(x for x in body["by_operator"] if x["operator_id"] == op_b.id)
    assert row_b["calls_total"] == 1
    assert row_b["unique_leads_touched"] == 1
    # No leads / sales for Bob in this window.
    assert row_b["total"] == 0
    assert row_b["sold_total"] == 0


@pytest.mark.django_db
def test_only_date_from_returns_400(api_client, manager):
    api_client.force_authenticate(manager)
    r = api_client.get(f"/api/analytics/lead-stats/?date_from={_today()}")
    assert r.status_code == 400


@pytest.mark.django_db
def test_bad_date_format_returns_400(api_client, manager):
    api_client.force_authenticate(manager)
    r = api_client.get(
        "/api/analytics/lead-stats/?date_from=2026-13-40&date_to=2026-13-41"
    )
    assert r.status_code == 400


@pytest.mark.django_db
def test_from_after_to_returns_400(api_client, manager):
    api_client.force_authenticate(manager)
    tomorrow = (timezone.localdate() + dt.timedelta(days=1)).strftime("%Y-%m-%d")
    today = _today()
    r = api_client.get(
        f"/api/analytics/lead-stats/?date_from={tomorrow}&date_to={today}"
    )
    assert r.status_code == 400


@pytest.mark.django_db
def test_range_too_wide_returns_400(api_client, manager):
    """> 92-day span is rejected — same guardrail as operator_activity_report()."""
    api_client.force_authenticate(manager)
    # 200 days > 92-day cap
    r = api_client.get(
        "/api/analytics/lead-stats/?date_from=2026-01-01&date_to=2026-07-19"
    )
    assert r.status_code == 400

"""
API tests for the operator-facing activity report endpoint:

  GET /api/reports/my-activity/  — anyone with an operator FK

Manager-facing `/api/reports/operator-activity/` was merged into
`/api/analytics/lead-stats/` — see `apps.analytics.apis.LeadStatsApi`.
"""

from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from apps.calls.models import CallAttempt, CallOutcome
from apps.leads.models import Lead, LeadStatus
from apps.operators.models import Operator, OperatorStatus
from apps.users.models import Profile, Role

User = get_user_model()


@pytest.fixture
def api_client():
    return APIClient()


@pytest.fixture
def op_a(db):
    return Operator.objects.create(full_name="Alice", status=OperatorStatus.ACTIVE)


@pytest.fixture
def op_b(db):
    return Operator.objects.create(full_name="Bob", status=OperatorStatus.ACTIVE)


@pytest.fixture
def user_alice(db, op_a):
    u = User.objects.create_user(username="alice", password="x")
    Profile.objects.create(user=u, role=Role.OPERATOR, operator=op_a)
    return u


@pytest.fixture
def manager(db):
    u = User.objects.create_user(username="mgr", password="x")
    Profile.objects.create(user=u, role=Role.MANAGER)
    return u


@pytest.fixture
def seed_calls(op_a, op_b):
    """A couple of calls today so the report has something."""
    lead1 = Lead.objects.create(full_name="L1", operator=op_a, status=LeadStatus.NEW)
    lead2 = Lead.objects.create(full_name="L2", operator=op_b, status=LeadStatus.NEW)
    CallAttempt.objects.create(lead=lead1, operator=op_a, outcome=CallOutcome.NO_ANSWER)
    CallAttempt.objects.create(lead=lead2, operator=op_b, outcome=CallOutcome.NO_ANSWER)
    CallAttempt.objects.create(lead=lead2, operator=op_b, outcome=CallOutcome.NO_ANSWER)
    return lead1, lead2


def _today() -> str:
    return timezone.localdate().strftime("%Y-%m-%d")


@pytest.mark.django_db
def test_my_activity_operator_scoped(api_client, user_alice, op_a, op_b, seed_calls):
    api_client.force_authenticate(user_alice)
    r = api_client.get(
        f"/api/reports/my-activity/?date_from={_today()}&date_to={_today()}"
    )
    assert r.status_code == 200
    rows = r.json()["rows"]
    assert len(rows) == 1
    assert rows[0]["operator_id"] == op_a.id
    # Bob's calls must NOT leak.
    assert rows[0]["calls_total"] == 1


@pytest.mark.django_db
def test_my_activity_unauth_returns_401(api_client):
    r = api_client.get(
        f"/api/reports/my-activity/?date_from={_today()}&date_to={_today()}"
    )
    assert r.status_code in (401, 403)


@pytest.mark.django_db
def test_my_activity_manager_without_operator_returns_400(api_client, manager):
    """Manager profile has no operator FK — endpoint returns 400 (not
    a crash)."""
    api_client.force_authenticate(manager)
    r = api_client.get(
        f"/api/reports/my-activity/?date_from={_today()}&date_to={_today()}"
    )
    assert r.status_code == 400

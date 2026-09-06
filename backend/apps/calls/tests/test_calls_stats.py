"""
Tests for /api/calls/stats/ — aggregated stats for the manager /calls page.
"""

from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from apps.calls.models import CallAttempt, CallOutcome, CallSource
from apps.leads.models import Lead, LeadStatus
from apps.operators.models import Operator, OperatorStatus
from apps.users.models import Profile, Role

User = get_user_model()


@pytest.fixture
def api_client():
    return APIClient()


@pytest.fixture
def op_a(db):
    return Operator.objects.create(full_name="OpA", status=OperatorStatus.ACTIVE)


@pytest.fixture
def op_b(db):
    return Operator.objects.create(full_name="OpB", status=OperatorStatus.ACTIVE)


@pytest.fixture
def manager(db):
    u = User.objects.create_user(username="mgr2", password="x")
    Profile.objects.create(user=u, role=Role.MANAGER)
    return u


@pytest.fixture
def lead_a(op_a):
    return Lead.objects.create(
        full_name="Lead A", phone="+998900000001", operator=op_a, status=LeadStatus.NEW
    )


def _mkcall(*, lead, operator, outcome="", duration=None):
    now = timezone.now()
    return CallAttempt.objects.create(
        lead=lead,
        operator=operator,
        outcome=outcome,
        source=CallSource.CLICK_TO_CALL,
        started_at=now,
        ended_at=now,
        duration_seconds=duration,
        phone_number=lead.phone,
    )


@pytest.mark.django_db
def test_stats_requires_manager(api_client):
    r = api_client.get("/api/calls/stats/")
    assert r.status_code in (401, 403)


@pytest.mark.django_db
def test_stats_shape_and_counts(api_client, manager, op_a, op_b, lead_a):
    _mkcall(lead=lead_a, operator=op_a, outcome=CallOutcome.TALKED_INTERESTED, duration=60)
    _mkcall(lead=lead_a, operator=op_a, outcome=CallOutcome.NO_ANSWER, duration=10)
    _mkcall(lead=lead_a, operator=op_b, outcome=CallOutcome.TALKED_CALLBACK, duration=30)
    _mkcall(lead=lead_a, operator=op_a, outcome="")  # skipped
    api_client.force_authenticate(manager)
    r = api_client.get("/api/calls/stats/")
    assert r.status_code == 200
    body = r.json()
    assert body["total_calls"] == 4
    # avg over the 3 with duration = (60+10+30)/3 ≈ 33.33
    assert body["avg_duration_seconds"] is not None
    assert 33 <= body["avg_duration_seconds"] <= 34
    # Answered = talked_interested + talked_callback = 2
    assert body["answered"] == 2
    assert 49 < body["answered_pct"] < 51
    # No recordings yet
    assert body["with_recording"] == 0
    assert body["recording_pct"] == 0.0
    # by_outcome breakdown
    assert body["by_outcome"].get(CallOutcome.TALKED_INTERESTED) == 1
    assert body["by_outcome"].get("") == 1
    # Top operators — op_a has 3 calls, op_b has 1
    tops = body["top_operators"]
    assert tops[0]["operator_id"] == op_a.id
    assert tops[0]["count"] == 3
    assert tops[1]["operator_id"] == op_b.id
    assert tops[1]["count"] == 1


@pytest.mark.django_db
def test_stats_operator_filter(api_client, manager, op_a, op_b, lead_a):
    _mkcall(lead=lead_a, operator=op_a, outcome=CallOutcome.TALKED_INTERESTED)
    _mkcall(lead=lead_a, operator=op_b, outcome=CallOutcome.NO_ANSWER)
    api_client.force_authenticate(manager)
    r = api_client.get(f"/api/calls/stats/?operator={op_a.id}")
    body = r.json()
    assert body["total_calls"] == 1

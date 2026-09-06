"""
Tests for the manager /calls list + filters + cursor pagination.
"""

from __future__ import annotations

import datetime as dt

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
    u = User.objects.create_user(username="mgr", password="x")
    Profile.objects.create(user=u, role=Role.MANAGER)
    return u


@pytest.fixture
def operator_user(db, op_a):
    u = User.objects.create_user(username="opuser", password="x")
    Profile.objects.create(user=u, role=Role.OPERATOR, operator=op_a)
    return u


@pytest.fixture
def lead_a(op_a):
    return Lead.objects.create(
        full_name="Lead A", phone="+998900000001", operator=op_a, status=LeadStatus.NEW
    )


@pytest.fixture
def lead_b(op_b):
    return Lead.objects.create(
        full_name="Lead B", phone="+998900000002", operator=op_b, status=LeadStatus.NEW
    )


def _mkcall(*, lead, operator, outcome="", duration=None, source=CallSource.CLICK_TO_CALL):
    now = timezone.now()
    return CallAttempt.objects.create(
        lead=lead,
        operator=operator,
        outcome=outcome,
        source=source,
        started_at=now,
        ended_at=now,
        duration_seconds=duration,
        phone_number=lead.phone,
    )


@pytest.mark.django_db
def test_list_requires_manager(api_client, operator_user, op_a, lead_a):
    _mkcall(lead=lead_a, operator=op_a, outcome=CallOutcome.NO_ANSWER)
    api_client.force_authenticate(operator_user)
    r = api_client.get("/api/calls/")
    assert r.status_code == 403


@pytest.mark.django_db
def test_list_returns_all_calls_for_manager(
    api_client, manager, op_a, op_b, lead_a, lead_b
):
    _mkcall(lead=lead_a, operator=op_a, outcome=CallOutcome.NO_ANSWER)
    _mkcall(lead=lead_b, operator=op_b, outcome=CallOutcome.TALKED_INTERESTED)
    api_client.force_authenticate(manager)
    r = api_client.get("/api/calls/")
    assert r.status_code == 200
    body = r.json()
    assert body["total"] == 2
    assert len(body["results"]) == 2


@pytest.mark.django_db
def test_filter_by_operator(api_client, manager, op_a, op_b, lead_a, lead_b):
    _mkcall(lead=lead_a, operator=op_a, outcome=CallOutcome.NO_ANSWER)
    _mkcall(lead=lead_b, operator=op_b, outcome=CallOutcome.TALKED_INTERESTED)
    api_client.force_authenticate(manager)
    r = api_client.get(f"/api/calls/?operator={op_a.id}")
    body = r.json()
    assert body["total"] == 1
    assert body["results"][0]["operator"] == op_a.id


@pytest.mark.django_db
def test_filter_by_outcome_including_empty(api_client, manager, op_a, lead_a):
    _mkcall(lead=lead_a, operator=op_a, outcome="")
    _mkcall(lead=lead_a, operator=op_a, outcome=CallOutcome.NO_ANSWER)
    _mkcall(lead=lead_a, operator=op_a, outcome=CallOutcome.TALKED_INTERESTED)
    api_client.force_authenticate(manager)
    r = api_client.get("/api/calls/?outcome=empty")
    assert r.json()["total"] == 1
    r = api_client.get(
        f"/api/calls/?outcome={CallOutcome.NO_ANSWER}&outcome={CallOutcome.TALKED_INTERESTED}"
    )
    assert r.json()["total"] == 2


@pytest.mark.django_db
def test_cursor_pagination(api_client, manager, op_a, lead_a):
    for _ in range(7):
        _mkcall(lead=lead_a, operator=op_a, outcome=CallOutcome.NO_ANSWER)
    api_client.force_authenticate(manager)
    r = api_client.get("/api/calls/?limit=3")
    b1 = r.json()
    assert len(b1["results"]) == 3
    assert b1["next_cursor"] is not None
    assert b1["total"] == 7
    r2 = api_client.get(f"/api/calls/?limit=3&cursor={b1['next_cursor']}")
    b2 = r2.json()
    assert len(b2["results"]) == 3
    # No overlap between pages.
    ids1 = {row["id"] for row in b1["results"]}
    ids2 = {row["id"] for row in b2["results"]}
    assert ids1.isdisjoint(ids2)


@pytest.mark.django_db
def test_date_range_filter(api_client, manager, op_a, lead_a):
    # Create one old call.
    call = _mkcall(lead=lead_a, operator=op_a, outcome=CallOutcome.NO_ANSWER)
    CallAttempt.objects.filter(pk=call.pk).update(
        created_at=timezone.now() - dt.timedelta(days=10)
    )
    # Fresh call.
    _mkcall(lead=lead_a, operator=op_a, outcome=CallOutcome.NO_ANSWER)
    api_client.force_authenticate(manager)
    today = timezone.now().date().strftime("%Y-%m-%d")
    r = api_client.get(f"/api/calls/?date_from={today}&date_to={today}")
    assert r.json()["total"] == 1


@pytest.mark.django_db
def test_has_recording_filter(api_client, manager, op_a, lead_a):
    _mkcall(lead=lead_a, operator=op_a, outcome=CallOutcome.NO_ANSWER)
    with_rec = _mkcall(lead=lead_a, operator=op_a, outcome=CallOutcome.TALKED_INTERESTED)
    with_rec.recording_url_asterisk = "https://rec.example/1.mp3"
    with_rec.save(update_fields=["recording_url_asterisk"])
    api_client.force_authenticate(manager)
    r = api_client.get("/api/calls/?has_recording=true")
    body = r.json()
    assert body["total"] == 1
    assert body["results"][0]["has_recording"] is True

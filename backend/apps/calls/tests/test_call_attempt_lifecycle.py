"""
Tests for click-to-call lifecycle (Фаза 1):
  - call_attempt_start creates a row with outcome="" and started_at=now
  - call_attempt_finish sets outcome/ended_at/duration_seconds
  - abandoned attempts (start without finish) remain in DB with outcome=""
  - permissions: operator cannot finish someone else's call attempt
  - GET /api/calls/mine/ returns per-operator metrics
"""

from __future__ import annotations

import datetime as dt

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from apps.calls.models import CallAttempt, CallOutcome, CallSource
from apps.calls.services import call_attempt_finish, call_attempt_start
from apps.leads.models import Lead, LeadStatus
from apps.operators.models import Operator, OperatorStatus
from apps.users.models import Profile, Role

User = get_user_model()


@pytest.fixture
def api_client():
    return APIClient()


@pytest.fixture
def op_alice(db):
    return Operator.objects.create(full_name="Alice", status=OperatorStatus.ACTIVE)


@pytest.fixture
def op_bob(db):
    return Operator.objects.create(full_name="Bob", status=OperatorStatus.ACTIVE)


@pytest.fixture
def user_alice(db, op_alice):
    u = User.objects.create_user(username="alice", password="x")
    Profile.objects.create(user=u, role=Role.OPERATOR, operator=op_alice)
    return u


@pytest.fixture
def user_bob(db, op_bob):
    u = User.objects.create_user(username="bob", password="x")
    Profile.objects.create(user=u, role=Role.OPERATOR, operator=op_bob)
    return u


@pytest.fixture
def manager(db):
    u = User.objects.create_user(username="mgr", password="x")
    Profile.objects.create(user=u, role=Role.MANAGER)
    return u


@pytest.fixture
def lead_of_alice(op_alice):
    return Lead.objects.create(
        full_name="Client X",
        phone="+998900001111",
        operator=op_alice,
        status=LeadStatus.NEW,
    )


# ---- service-level lifecycle -----------------------------------------------


@pytest.mark.django_db
def test_start_creates_row_with_empty_outcome(lead_of_alice, op_alice):
    a = call_attempt_start(
        lead=lead_of_alice,
        operator=op_alice,
        source=CallSource.CLICK_TO_CALL,
    )
    assert a.outcome == ""
    assert a.started_at is not None
    assert a.ended_at is None
    assert a.duration_seconds is None
    # Снимок номера должен сохраниться.
    assert a.phone_number == lead_of_alice.phone
    assert a.source == CallSource.CLICK_TO_CALL


@pytest.mark.django_db
def test_finish_sets_outcome_and_duration(lead_of_alice, op_alice):
    a = call_attempt_start(lead=lead_of_alice, operator=op_alice)
    # Мокаем started_at на 30 секунд назад — тогда автопосчёт duration
    # должен получить ≥ 30.
    a.started_at = timezone.now() - dt.timedelta(seconds=30)
    a.save(update_fields=["started_at"])
    a = call_attempt_finish(
        call_attempt=a, outcome=CallOutcome.TALKED_INTERESTED
    )
    assert a.outcome == CallOutcome.TALKED_INTERESTED
    assert a.ended_at is not None
    assert a.duration_seconds is not None
    assert a.duration_seconds >= 29  # чуть-чуть люфта на timing
    # Лид перешёл в in_progress.
    lead_of_alice.refresh_from_db()
    assert lead_of_alice.status == LeadStatus.IN_PROGRESS


@pytest.mark.django_db
def test_finish_without_outcome_leaves_row_open_but_ended(lead_of_alice, op_alice):
    """Оператор нажал «Пропустить» в модалке — outcome остаётся пустым,
    но ended_at выставляется (звонок физически завершён)."""
    a = call_attempt_start(lead=lead_of_alice, operator=op_alice)
    a = call_attempt_finish(call_attempt=a, outcome="")
    assert a.outcome == ""
    assert a.ended_at is not None


@pytest.mark.django_db
def test_start_without_finish_stays_in_db(lead_of_alice, op_alice):
    """Оператор кликнул 📞, но не вернулся — ряд не потерян."""
    a = call_attempt_start(lead=lead_of_alice, operator=op_alice)
    assert CallAttempt.objects.filter(pk=a.pk).exists()
    a.refresh_from_db()
    assert a.ended_at is None


@pytest.mark.django_db
def test_finish_is_idempotent_on_ended_at(lead_of_alice, op_alice):
    a = call_attempt_start(lead=lead_of_alice, operator=op_alice)
    a = call_attempt_finish(call_attempt=a, outcome=CallOutcome.REJECTED)
    first_ended_at = a.ended_at
    # Second call shouldn't move ended_at back — оставляем оригинальный.
    a = call_attempt_finish(call_attempt=a, outcome=CallOutcome.REJECTED)
    assert a.ended_at == first_ended_at


# ---- API: /api/calls/start/ + /finish/ ------------------------------------


@pytest.mark.django_db
def test_api_start_creates_attempt(api_client, user_alice, lead_of_alice):
    api_client.force_authenticate(user_alice)
    r = api_client.post(
        "/api/calls/start/", {"lead_id": lead_of_alice.id}, format="json"
    )
    assert r.status_code == 201, r.content
    data = r.json()
    assert data["outcome"] == ""
    assert data["started_at"] is not None
    assert data["source"] == CallSource.CLICK_TO_CALL


@pytest.mark.django_db
def test_api_start_missing_lead_400(api_client, user_alice):
    api_client.force_authenticate(user_alice)
    r = api_client.post("/api/calls/start/", {"lead_id": 999999}, format="json")
    assert r.status_code == 404


@pytest.mark.django_db
def test_api_finish_marks_outcome(api_client, user_alice, lead_of_alice, op_alice):
    a = call_attempt_start(lead=lead_of_alice, operator=op_alice)
    api_client.force_authenticate(user_alice)
    r = api_client.patch(
        f"/api/calls/{a.id}/finish/",
        {"outcome": CallOutcome.NO_ANSWER, "duration_seconds": 12},
        format="json",
    )
    assert r.status_code == 200, r.content
    a.refresh_from_db()
    assert a.outcome == CallOutcome.NO_ANSWER
    assert a.duration_seconds == 12
    assert a.ended_at is not None


@pytest.mark.django_db
def test_api_finish_forbidden_for_foreign_operator(
    api_client, user_bob, lead_of_alice, op_alice
):
    """Bob не может закрыть звонок Alice."""
    a = call_attempt_start(lead=lead_of_alice, operator=op_alice)
    api_client.force_authenticate(user_bob)
    r = api_client.patch(
        f"/api/calls/{a.id}/finish/",
        {"outcome": CallOutcome.REJECTED},
        format="json",
    )
    assert r.status_code == 403


@pytest.mark.django_db
def test_api_finish_allowed_for_manager(
    api_client, manager, lead_of_alice, op_alice
):
    a = call_attempt_start(lead=lead_of_alice, operator=op_alice)
    api_client.force_authenticate(manager)
    r = api_client.patch(
        f"/api/calls/{a.id}/finish/",
        {"outcome": CallOutcome.REJECTED},
        format="json",
    )
    assert r.status_code == 200


# ---- API: /api/calls/mine/ metrics ---------------------------------------


@pytest.mark.django_db
def test_api_mine_metrics(api_client, user_alice, lead_of_alice, op_alice):
    # Один завершённый звонок + одна открытая попытка.
    a1 = call_attempt_start(lead=lead_of_alice, operator=op_alice)
    call_attempt_finish(
        call_attempt=a1, outcome=CallOutcome.NO_ANSWER, duration_seconds=42
    )
    call_attempt_start(lead=lead_of_alice, operator=op_alice)

    api_client.force_authenticate(user_alice)
    r = api_client.get("/api/calls/mine/?days=1")
    assert r.status_code == 200, r.content
    data = r.json()
    assert data["total"] == 2
    assert data["avg_duration_seconds"] == 42.0
    # Открытый ряд имеет outcome="" — считается отдельным bucket'ом.
    assert data["by_outcome"].get(CallOutcome.NO_ANSWER) == 1
    assert data["by_outcome"].get("") == 1


@pytest.mark.django_db
def test_api_mine_metrics_operator_scoped(
    api_client, user_alice, op_alice, op_bob, lead_of_alice
):
    """Bob's calls не должны прилипать к Alice."""
    lead_of_bob = Lead.objects.create(full_name="B", phone="+998900002222", operator=op_bob)
    call_attempt_start(lead=lead_of_alice, operator=op_alice)
    call_attempt_start(lead=lead_of_bob, operator=op_bob)

    api_client.force_authenticate(user_alice)
    r = api_client.get("/api/calls/mine/?days=1")
    assert r.json()["total"] == 1

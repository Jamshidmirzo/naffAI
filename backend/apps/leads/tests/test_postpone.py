"""
Operator "postpone lead for later" feature.

- Operator can postpone their own lead → falls out of "active" view, appears
  in "postponed" view. Audit written.
- Cannot postpone someone else's lead → 403.
- unpostpone reverses the flags.
- `leads_for_operator(view=...)` filters correctly.
- `lead_reassign` clears postpone flags so the new operator gets a fresh lead.
"""

from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from apps.audit.models import AuditLog
from apps.common.exceptions import ApplicationError
from apps.leads.models import Lead
from apps.leads.selectors import leads_for_operator
from apps.leads.services import (
    lead_create,
    lead_postpone,
    lead_reassign,
    lead_unpostpone,
)
from apps.operators.models import Operator, OperatorStatus
from apps.users.models import Profile, Role

User = get_user_model()


@pytest.fixture
def operator(db):
    return Operator.objects.create(full_name="Sevara", status=OperatorStatus.ACTIVE)


@pytest.fixture
def other_operator(db):
    return Operator.objects.create(full_name="Nurik", status=OperatorStatus.ACTIVE)


@pytest.fixture
def operator_user(db, operator):
    u = User.objects.create_user(username="sevara", password="x")
    Profile.objects.create(user=u, role=Role.OPERATOR, operator=operator)
    return u


@pytest.fixture
def api_client(operator_user):
    c = APIClient()
    c.force_authenticate(user=operator_user)
    return c


def _attach(lead: Lead, op: Operator) -> Lead:
    lead.operator = op
    lead.save(update_fields=["operator"])
    return lead


@pytest.mark.django_db
def test_lead_postpone_sets_fields(operator):
    lead = _attach(
        lead_create(full_name="A", phone="+998900001111", auto_assign=False),
        operator,
    )

    lead_postpone(lead=lead, operator=operator, reason="после обеда")

    lead.refresh_from_db()
    assert lead.postponed_at is not None
    assert lead.postponed_by_id == operator.id
    assert lead.postpone_reason == "после обеда"

    entry = AuditLog.objects.filter(
        entity="leads.Lead", entity_id=str(lead.id)
    ).order_by("-created_at").first()
    assert entry is not None
    assert entry.comment == "postponed by operator"


@pytest.mark.django_db
def test_lead_postpone_wrong_operator_forbidden(operator, other_operator):
    """Service-level guard: even bypassing the API, foreign postpone raises."""
    lead = _attach(
        lead_create(full_name="B", phone="+998900001112", auto_assign=False),
        operator,
    )
    with pytest.raises(ApplicationError):
        lead_postpone(lead=lead, operator=other_operator, reason="")
    lead.refresh_from_db()
    assert lead.postponed_at is None


@pytest.mark.django_db
def test_lead_postpone_api_foreign_lead_forbidden(api_client, other_operator):
    """HTTP path — same guard, 403 to a foreign lead."""
    foreign = _attach(
        lead_create(full_name="C", phone="+998900001113", auto_assign=False),
        other_operator,
    )
    resp = api_client.post(f"/api/leads/{foreign.id}/postpone/", {"reason": "x"}, format="json")
    assert resp.status_code == 403
    foreign.refresh_from_db()
    assert foreign.postponed_at is None


@pytest.mark.django_db
def test_lead_unpostpone_clears_fields(operator):
    lead = _attach(
        lead_create(full_name="D", phone="+998900001114", auto_assign=False),
        operator,
    )
    lead_postpone(lead=lead, operator=operator, reason="сегодня вечером")
    lead_unpostpone(lead=lead, operator=operator)

    lead.refresh_from_db()
    assert lead.postponed_at is None
    assert lead.postponed_by_id is None
    assert lead.postpone_reason == ""


@pytest.mark.django_db
def test_leads_for_operator_view_filter(operator):
    active_ids = []
    for i in range(3):
        lead = _attach(
            lead_create(full_name=f"A{i}", phone=f"+99890000200{i}", auto_assign=False),
            operator,
        )
        active_ids.append(lead.id)
    postponed_ids = []
    for i in range(2):
        lead = _attach(
            lead_create(full_name=f"P{i}", phone=f"+99890000210{i}", auto_assign=False),
            operator,
        )
        lead_postpone(lead=lead, operator=operator)
        postponed_ids.append(lead.id)

    assert leads_for_operator(operator, view="active").count() == 3
    assert leads_for_operator(operator, view="postponed").count() == 2
    assert leads_for_operator(operator, view="all").count() == 5


@pytest.mark.django_db
def test_lead_reassign_clears_postpone(operator, other_operator):
    lead = _attach(
        lead_create(full_name="R", phone="+998900001115", auto_assign=False),
        operator,
    )
    lead_postpone(lead=lead, operator=operator, reason="перезвонить завтра")
    assert lead.postponed_at is not None

    lead_reassign(lead=lead, new_operator=other_operator, reason="manual")

    lead.refresh_from_db()
    assert lead.operator_id == other_operator.id
    assert lead.postponed_at is None
    assert lead.postponed_by_id is None
    assert lead.postpone_reason == ""

    # The new operator sees the lead as active, not postponed.
    assert leads_for_operator(other_operator, view="active").filter(id=lead.id).exists()
    assert not leads_for_operator(other_operator, view="postponed").filter(id=lead.id).exists()


@pytest.mark.django_db
def test_my_leads_response_has_counts(api_client, operator):
    for i in range(2):
        _attach(
            lead_create(full_name=f"A{i}", phone=f"+99890000300{i}", auto_assign=False),
            operator,
        )
    p = _attach(
        lead_create(full_name="P", phone="+998900003100", auto_assign=False),
        operator,
    )
    lead_postpone(lead=p, operator=operator)

    resp = api_client.get("/api/leads/my/?view=active")
    assert resp.status_code == 200
    body = resp.json()
    assert body["counts"] == {"active": 2, "postponed": 1}
    assert len(body["results"]) == 2

    resp = api_client.get("/api/leads/my/?view=postponed")
    assert len(resp.json()["results"]) == 1

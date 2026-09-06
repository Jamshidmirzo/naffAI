"""
Mobile leads listing — scoping + pagination.

We exercise auth via `force_authenticate` (not the real JWT flow) so the
tests stay focused on the endpoint contract itself; the JWT plumbing is
covered by `apps.users.tests.test_mobile_login`.
"""

from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from apps.leads.models import Lead, LeadStatus
from apps.operators.models import Operator
from apps.users.models import Profile, Role
from apps.users.services import account_create_for_operator

User = get_user_model()


@pytest.fixture
def api() -> APIClient:
    return APIClient()


@pytest.fixture
def manager(db):
    u = User.objects.create_user(username="mgr", password="mgrpass1")
    Profile.objects.create(user=u, role=Role.MANAGER)
    return u


@pytest.fixture
def op_a(db):
    return Operator.objects.create(full_name="A", phone="+998900000001", status="active")


@pytest.fixture
def op_b(db):
    return Operator.objects.create(full_name="B", phone="+998900000002", status="active")


@pytest.fixture
def user_a(db, manager, op_a):
    user, _ = account_create_for_operator(operator=op_a, actor=manager)
    return user


def _make_leads(operator: Operator, n: int) -> list[Lead]:
    leads: list[Lead] = []
    for i in range(n):
        leads.append(
            Lead.objects.create(
                full_name=f"L{i}",
                phone=f"+99890000{i:04d}",
                status=LeadStatus.ASSIGNED,
                operator=operator,
            )
        )
    return leads


@pytest.mark.django_db
def test_operator_sees_only_own_leads(api, user_a, op_a, op_b):
    _make_leads(op_a, 3)
    _make_leads(op_b, 5)
    api.force_authenticate(user_a)
    r = api.get("/api/mobile/leads/my/")
    assert r.status_code == 200
    body = r.json()
    assert len(body["results"]) == 3
    assert body["next_cursor"] is None
    op_ids = {row["operator"] for row in body["results"]}
    assert op_ids == {op_a.id}


@pytest.mark.django_db
def test_cursor_pagination(api, user_a, op_a):
    _make_leads(op_a, 5)
    api.force_authenticate(user_a)

    r = api.get("/api/mobile/leads/my/?limit=2")
    assert r.status_code == 200
    page1 = r.json()
    assert len(page1["results"]) == 2
    assert page1["next_cursor"] is not None

    r2 = api.get(f"/api/mobile/leads/my/?limit=2&cursor={page1['next_cursor']}")
    assert r2.status_code == 200
    page2 = r2.json()
    assert len(page2["results"]) == 2

    # No cross-contamination between pages.
    ids1 = {row["id"] for row in page1["results"]}
    ids2 = {row["id"] for row in page2["results"]}
    assert ids1.isdisjoint(ids2)


@pytest.mark.django_db
def test_unauthenticated_denied(api):
    r = api.get("/api/mobile/leads/my/")
    assert r.status_code in (401, 403)


@pytest.mark.django_db
def test_manager_gets_empty_list(api, manager):
    api.force_authenticate(manager)
    r = api.get("/api/mobile/leads/my/")
    assert r.status_code == 200
    # Manager has no operator FK — endpoint intentionally returns [].
    assert r.json() == {"results": [], "next_cursor": None}

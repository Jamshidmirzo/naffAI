"""
PATCH /api/mobile/leads/{id}/status/ — permission + audit trail.

The status-update service is the same one the web CRM uses, so we only
verify the mobile façade routes through it (audit row appears, status
persists) and enforces the operator-owns-lead scoping.
"""

from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from apps.audit.models import AuditLog
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


@pytest.mark.django_db
def test_owner_can_update_status(api, user_a, op_a):
    lead = Lead.objects.create(
        full_name="X", phone="+998900000010",
        status=LeadStatus.ASSIGNED, operator=op_a,
    )
    api.force_authenticate(user_a)
    r = api.patch(
        f"/api/mobile/leads/{lead.id}/status/",
        {"status": LeadStatus.IN_PROGRESS, "comment": "поехал"},
        format="json",
    )
    assert r.status_code == 200, r.content
    lead.refresh_from_db()
    assert lead.status == LeadStatus.IN_PROGRESS
    # Audit row was written by lead_update_status → mobile inherits it.
    assert AuditLog.objects.filter(
        entity="leads.Lead", entity_id=lead.id
    ).exists()


@pytest.mark.django_db
def test_operator_cant_touch_someone_elses_lead(api, user_a, op_b):
    lead = Lead.objects.create(
        full_name="Y", phone="+998900000011",
        status=LeadStatus.ASSIGNED, operator=op_b,
    )
    api.force_authenticate(user_a)
    r = api.patch(
        f"/api/mobile/leads/{lead.id}/status/",
        {"status": LeadStatus.IN_PROGRESS},
        format="json",
    )
    assert r.status_code == 403
    lead.refresh_from_db()
    assert lead.status == LeadStatus.ASSIGNED


@pytest.mark.django_db
def test_lead_detail_scope(api, user_a, op_a, op_b):
    own = Lead.objects.create(
        full_name="Own", phone="+998900000020",
        status=LeadStatus.ASSIGNED, operator=op_a,
    )
    other = Lead.objects.create(
        full_name="Other", phone="+998900000021",
        status=LeadStatus.ASSIGNED, operator=op_b,
    )
    api.force_authenticate(user_a)
    assert api.get(f"/api/mobile/leads/{own.id}/").status_code == 200
    assert api.get(f"/api/mobile/leads/{other.id}/").status_code == 403


@pytest.mark.django_db
def test_manager_can_read_and_write_any_lead(api, manager, op_a):
    lead = Lead.objects.create(
        full_name="Z", phone="+998900000030",
        status=LeadStatus.ASSIGNED, operator=op_a,
    )
    api.force_authenticate(manager)
    r = api.get(f"/api/mobile/leads/{lead.id}/")
    assert r.status_code == 200
    r2 = api.patch(
        f"/api/mobile/leads/{lead.id}/status/",
        {"status": LeadStatus.IN_PROGRESS},
        format="json",
    )
    assert r2.status_code == 200

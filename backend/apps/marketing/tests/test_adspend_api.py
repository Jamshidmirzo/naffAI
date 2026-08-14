"""
AdSpend CRUD API — permissions + basic list/create/update/delete flow.
"""

from __future__ import annotations

import datetime as dt

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from apps.leads.models import SheetSource
from apps.marketing.models import AdSpend
from apps.users.models import Profile, Role

User = get_user_model()


@pytest.fixture
def api():
    return APIClient()


@pytest.fixture
def manager(db):
    u = User.objects.create_user(username="mgr", password="x")
    Profile.objects.create(user=u, role=Role.MANAGER)
    return u


@pytest.fixture
def operator(db):
    u = User.objects.create_user(username="op", password="x")
    Profile.objects.create(user=u, role=Role.OPERATOR)
    return u


@pytest.fixture
def sheet(db):
    return SheetSource.objects.create(name="Instagram_Q3", spreadsheet_id="ss", gid=42)


@pytest.mark.django_db
def test_adspend_create_requires_manager(api, operator):
    api.force_authenticate(operator)
    r = api.post(
        "/api/marketing/adspend/",
        {
            "period_start": "2026-08-01",
            "period_end": "2026-08-07",
            "source_label": "Test",
            "amount": "1000000",
        },
        format="json",
    )
    assert r.status_code == 403


@pytest.mark.django_db
def test_adspend_full_crud_flow(api, manager, sheet):
    api.force_authenticate(manager)

    # Create
    r = api.post(
        "/api/marketing/adspend/",
        {
            "period_start": "2026-08-01",
            "period_end": "2026-08-07",
            "source": sheet.id,
            "amount": "5000000",
            "note": "Q3 ad-set A",
        },
        format="json",
    )
    assert r.status_code == 201, r.content
    ad_id = r.json()["id"]
    assert r.json()["source_name"] == "Instagram_Q3"

    # List (unfiltered) — should include it.
    r = api.get("/api/marketing/adspend/")
    assert r.status_code == 200
    assert any(a["id"] == ad_id for a in r.json())

    # List with source filter.
    r = api.get(f"/api/marketing/adspend/?source={sheet.id}")
    assert r.status_code == 200
    assert len(r.json()) == 1

    # Patch (update amount).
    r = api.patch(f"/api/marketing/adspend/{ad_id}/", {"amount": "7500000"}, format="json")
    assert r.status_code == 200
    assert float(r.json()["amount"]) == 7500000.0

    # Delete.
    r = api.delete(f"/api/marketing/adspend/{ad_id}/")
    assert r.status_code == 204
    assert not AdSpend.objects.filter(pk=ad_id).exists()


@pytest.mark.django_db
def test_adspend_reject_invalid_amount(api, manager):
    api.force_authenticate(manager)
    r = api.post(
        "/api/marketing/adspend/",
        {
            "period_start": "2026-08-01",
            "period_end": "2026-08-07",
            "source_label": "Test",
            "amount": "-100",
        },
        format="json",
    )
    assert r.status_code == 400


@pytest.mark.django_db
def test_adspend_reject_end_before_start(api, manager):
    api.force_authenticate(manager)
    r = api.post(
        "/api/marketing/adspend/",
        {
            "period_start": "2026-08-10",
            "period_end": "2026-08-05",
            "source_label": "Test",
            "amount": "100000",
        },
        format="json",
    )
    assert r.status_code == 400

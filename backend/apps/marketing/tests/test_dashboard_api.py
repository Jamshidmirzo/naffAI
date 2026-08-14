"""
Marketing dashboard endpoint + export.
"""

from __future__ import annotations

import datetime as dt

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from apps.catalog.models import Channel
from apps.leads.models import Lead, LeadStatus, SheetSource
from apps.operators.models import Operator
from apps.users.models import Profile, Role

User = get_user_model()


@pytest.fixture
def api():
    return APIClient()


@pytest.fixture
def manager(db):
    u = User.objects.create_user(username="mgr-dash", password="x")
    Profile.objects.create(user=u, role=Role.MANAGER)
    return u


@pytest.fixture
def sheet(db):
    return SheetSource.objects.create(name="TestSrc", spreadsheet_id="ss", gid=1)


@pytest.mark.django_db
def test_dashboard_returns_all_sections(api, manager, sheet):
    Lead.objects.create(sheet_source=sheet, status=LeadStatus.NEW)
    api.force_authenticate(manager)

    end = timezone.localdate().isoformat()
    start = (timezone.localdate() - dt.timedelta(days=7)).isoformat()
    r = api.get(f"/api/marketing/dashboard/?date_from={start}&date_to={end}")
    assert r.status_code == 200
    body = r.json()
    for key in (
        "period", "totals", "sources", "funnels", "time_patterns",
        "rejection_reasons", "channels", "cohorts", "wow", "adspend_summary",
        "latest_insight_id",
    ):
        assert key in body


@pytest.mark.django_db
def test_dashboard_requires_manager(api):
    r = api.get("/api/marketing/dashboard/")
    assert r.status_code in (401, 403)


@pytest.mark.django_db
def test_export_xlsx(api, manager, sheet):
    Lead.objects.create(sheet_source=sheet, status=LeadStatus.NEW)
    api.force_authenticate(manager)
    r = api.get("/api/marketing/export.xlsx/")
    assert r.status_code == 200
    assert "spreadsheet" in r["Content-Type"]

"""Legacy marketing service tests — updated for the redesigned service.

These preserve the intent of the original F3.B tests (upsert, LLM path,
fallback path) but use the new `generate_content` interface.
"""

from __future__ import annotations

import datetime as dt
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from apps.leads.models import Lead, LeadStatus, SheetSource
from apps.marketing.models import MarketingInsight
from apps.marketing.services import generate_marketing_insight
from apps.tg_userclient.ai.provider import LLMResponse
from apps.users.models import Profile, Role

User = get_user_model()


@pytest.fixture
def sheet(db):
    return SheetSource.objects.create(name="Sheet A", spreadsheet_id="ss", gid=0)


@pytest.fixture
def manager(db):
    u = User.objects.create_user(username="mkt-mgr", password="x")
    Profile.objects.create(user=u, role=Role.MANAGER)
    return u


@pytest.fixture
def api():
    return APIClient()


@pytest.mark.django_db
def test_generate_insight_upserts_row(sheet):
    Lead.objects.create(sheet_source=sheet, status=LeadStatus.NEW, product_hint="iPhone 15")
    Lead.objects.create(sheet_source=sheet, status=LeadStatus.WON, product_hint="iPhone 15")
    period_end = timezone.localdate()
    period_start = period_end - dt.timedelta(days=6)
    insight = generate_marketing_insight(period_start=period_start, period_end=period_end)
    assert insight.id is not None
    assert insight.period_start == period_start
    assert insight.period_end == period_end
    # New structured field is populated (fallback or LLM).
    assert isinstance(insight.structured_output, dict)
    assert "summary" in insight.structured_output
    # Second call is idempotent — upserts the same row.
    insight2 = generate_marketing_insight(period_start=period_start, period_end=period_end)
    assert insight2.id == insight.id
    assert MarketingInsight.objects.count() == 1


@pytest.mark.django_db
def test_generate_insight_uses_llm_when_valid_json(sheet):
    Lead.objects.create(sheet_source=sheet, status=LeadStatus.NEW)
    end = timezone.localdate()
    start = end - dt.timedelta(days=6)
    good_json = (
        '{"summary": "Sheet A конвертит", '
        '"highlights": [{"type": "win", "text": "лид/конв"}], '
        '"recommendations": [{"priority": "high", "action": "Больше Sheet A", '
        '"source": "Sheet A", "evidence": "high conv"}]}'
    )
    with patch("apps.marketing.services.get_marketing_provider") as gp:

        class P:
            def generate_content(self, *, prompt, response_json=False):
                return LLMResponse(text=good_json, model_used="test-model", provider="test")

        gp.return_value = P()
        insight = generate_marketing_insight(period_start=start, period_end=end)

    assert insight.summary == "Sheet A конвертит"
    assert insight.model_version == "test-model"
    assert insight.provider_used == "test"
    # Legacy field derived from structured recommendations.
    assert any("Больше Sheet A" in r for r in insight.targeting_recommendations)


@pytest.mark.django_db
def test_generate_insight_falls_back_when_llm_fails(sheet):
    Lead.objects.create(sheet_source=sheet, status=LeadStatus.NEW)
    end = timezone.localdate()
    start = end - dt.timedelta(days=6)
    with patch("apps.marketing.services.get_marketing_provider") as gp:

        class P:
            def generate_content(self, *, prompt, response_json=False):
                raise RuntimeError("boom")

        gp.return_value = P()
        insight = generate_marketing_insight(period_start=start, period_end=end)
    assert insight.model_version == "fallback"
    assert isinstance(insight.structured_output, dict)
    assert "summary" in insight.structured_output


@pytest.mark.django_db
def test_insights_list_api(api, manager, sheet):
    generate_marketing_insight(
        period_start=timezone.localdate() - dt.timedelta(days=6),
        period_end=timezone.localdate(),
    )
    api.force_authenticate(manager)
    r = api.get("/api/marketing/insights/")
    assert r.status_code == 200
    data = r.json()
    rows = data if isinstance(data, list) else data.get("results", [])
    assert len(rows) == 1

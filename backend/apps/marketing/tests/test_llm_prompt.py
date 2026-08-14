"""
LLM prompt / validator tests: schema validator catches malformed output,
retry falls back to static analyser.
"""

from __future__ import annotations

import datetime as dt
import json
from unittest.mock import patch

import pytest
from django.utils import timezone

from apps.leads.models import Lead, LeadStatus, SheetSource
from apps.marketing.services import (
    _run_llm,
    build_dashboard_payload,
    generate_marketing_insight,
    validate_structured_output,
)
from apps.tg_userclient.ai.provider import LLMResponse


@pytest.fixture
def sheet(db):
    return SheetSource.objects.create(name="TestSrc", spreadsheet_id="ss", gid=999)


# ---- validate_structured_output --------------------------------------


def test_validator_accepts_good():
    good = {
        "summary": "OK",
        "highlights": [{"type": "win", "text": "abc"}],
        "recommendations": [
            {
                "priority": "high",
                "action": "act",
                "source": "src",
                "evidence": "ev",
            }
        ],
    }
    ok, err = validate_structured_output(good)
    assert ok, err


def test_validator_rejects_missing_keys():
    bad = {"summary": "x"}
    ok, err = validate_structured_output(bad)
    assert not ok
    assert "missing" in err


def test_validator_rejects_bad_priority():
    bad = {
        "summary": "x",
        "highlights": [],
        "recommendations": [
            {"priority": "URGENT", "action": "a", "source": "s", "evidence": "e"}
        ],
    }
    ok, err = validate_structured_output(bad)
    assert not ok
    assert "priority" in err


def test_validator_rejects_non_dict():
    ok, err = validate_structured_output(["not", "a", "dict"])
    assert not ok


# ---- _run_llm -------------------------------------------------------


@pytest.mark.django_db
def test_run_llm_uses_valid_json(sheet):
    Lead.objects.create(sheet_source=sheet, status=LeadStatus.NEW)
    end = timezone.localdate()
    start = end - dt.timedelta(days=6)
    payload = build_dashboard_payload(period_start=start, period_end=end)

    good = {
        "summary": "test",
        "highlights": [{"type": "win", "text": "good"}],
        "recommendations": [
            {"priority": "high", "action": "a", "source": "s",
             "evidence": "e", "expected_impact": "1M", "confidence": 0.8}
        ],
        "questions_for_owner": ["q1"],
    }
    with patch("apps.marketing.services.get_marketing_provider") as gp:

        class P:
            def generate_content(self, *, prompt, response_json=False, max_tokens=2000):
                return LLMResponse(text=json.dumps(good), model_used="m", provider="p")

        gp.return_value = P()
        structured, mv, pu = _run_llm(payload)

    assert structured["summary"] == "test"
    assert structured["recommendations"][0]["action"] == "a"
    assert mv == "m"
    assert pu == "p"


@pytest.mark.django_db
def test_run_llm_falls_back_on_invalid_json(sheet):
    Lead.objects.create(sheet_source=sheet, status=LeadStatus.NEW)
    end = timezone.localdate()
    start = end - dt.timedelta(days=6)
    payload = build_dashboard_payload(period_start=start, period_end=end)

    with patch("apps.marketing.services.get_marketing_provider") as gp:

        class P:
            def generate_content(self, *, prompt, response_json=False, max_tokens=2000):
                return LLMResponse(text="not json at all", model_used="m", provider="p")

        gp.return_value = P()
        structured, mv, _ = _run_llm(payload)

    # Fallback: schema-valid structure produced deterministically.
    ok, err = validate_structured_output(structured)
    assert ok, err
    assert "summary" in structured
    assert mv == "invalid_json_fallback"


@pytest.mark.django_db
def test_generate_marketing_insight_persists_snapshot(sheet):
    Lead.objects.create(sheet_source=sheet, status=LeadStatus.NEW)
    end = timezone.localdate()
    start = end - dt.timedelta(days=6)
    insight = generate_marketing_insight(period_start=start, period_end=end)
    # Snapshot has all the sections.
    snap = insight.dashboard_payload_snapshot
    assert "sources" in snap
    assert "totals" in snap
    assert "wow" in snap

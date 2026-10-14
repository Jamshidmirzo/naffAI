"""
Integration test: run_morning_briefing with ROP_ENABLED=True and the LLM
stubbed. Verifies the service composes a KPI snapshot, calls LLM, and
persists DailyBriefing — all without hitting Telegram (TG push is a no-op
because TELEGRAM_BOT_TOKEN is empty in the test env).
"""

from __future__ import annotations

from unittest.mock import patch

import pytest
from django.test import override_settings

from apps.rop_agent import services
from apps.rop_agent.models import DailyBriefing, ROPState


@pytest.mark.django_db
@override_settings(ROP_ENABLED=True)
def test_morning_briefing_dry_run_builds_without_tg():
    with patch(
        "apps.rop_agent.services.llm.synthesize",
        return_value={"text": "SYNTH", "tokens_in": 10, "tokens_out": 20, "model": "stub"},
    ):
        result = services.run_morning_briefing(dry_run=True)
    assert result.get("dry_run") is True
    assert "SYNTH" in result["preview"]
    # dry_run must not persist anything
    assert DailyBriefing.objects.count() == 0


@pytest.mark.django_db
@override_settings(ROP_ENABLED=True)
def test_morning_briefing_persists_and_marks_state():
    with patch(
        "apps.rop_agent.services.llm.synthesize",
        return_value={"text": "SYNTH", "tokens_in": 10, "tokens_out": 20, "model": "stub"},
    ), patch(
        "apps.rop_agent.services.telegram.send_to_owner",
        return_value=12345,
    ):
        result = services.run_morning_briefing(dry_run=False)
    assert result.get("sent") is True
    br = DailyBriefing.objects.get()
    assert br.tg_message_id == 12345
    assert br.model_used == "stub"
    state = ROPState.get_solo()
    assert state.last_briefing_at is not None


@pytest.mark.django_db
@override_settings(ROP_ENABLED=False)
def test_morning_briefing_respects_disabled_flag():
    result = services.run_morning_briefing(dry_run=False)
    assert result == {"skipped": "disabled"}
    assert DailyBriefing.objects.count() == 0

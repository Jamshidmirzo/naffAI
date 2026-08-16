"""Verifies that ``generate_daily_lesson(..., language=...)`` picks the
right prompt file and passes it to the LLM. We inspect the prompt the
fake provider receives — no LLM call is actually made.
"""

from unittest.mock import patch

from apps.tg_userclient.ai.provider import LLMResponse
from apps.lessons.ai.generator import generate_daily_lesson


class CapturingProvider:
    def __init__(self):
        self.last_prompt: str | None = None

    def generate_content(self, *, prompt, response_json=False):
        self.last_prompt = prompt
        return LLMResponse(
            text='{"greeting_line":"","yesterday_summary":"s","main_insight":{"title":"","text":""},'
                 '"highlights":[],"blockers":[],"practice_today":[],"micro_lesson":"m","closing_line":""}',
            model_used="fake",
            provider="fake",
        )


def test_language_ru_uses_ru_prompt():
    provider = CapturingProvider()
    with patch("apps.lessons.ai.generator.get_llm_provider", return_value=provider):
        generate_daily_lesson("A", 1, {"chat_examples": []}, language="ru")
    assert provider.last_prompt is not None
    # RU prompt file starts with the Russian intro line
    assert "наставник продавца" in provider.last_prompt.lower()


def test_language_uz_uses_uz_prompt():
    provider = CapturingProvider()
    with patch("apps.lessons.ai.generator.get_llm_provider", return_value=provider):
        generate_daily_lesson("A", 1, {"chat_examples": []}, language="uz")
    assert provider.last_prompt is not None
    # UZ prompt uses Latin Uzbek
    assert "ustoz" in provider.last_prompt.lower() or "o'zbek" in provider.last_prompt.lower()


def test_language_unknown_falls_back_to_ru():
    provider = CapturingProvider()
    with patch("apps.lessons.ai.generator.get_llm_provider", return_value=provider):
        generate_daily_lesson("A", 1, {"chat_examples": []}, language="ja")
    assert provider.last_prompt is not None
    assert "наставник продавца" in provider.last_prompt.lower()

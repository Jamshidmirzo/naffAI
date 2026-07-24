import pytest
from unittest.mock import patch

from apps.tg_userclient.ai.provider import LLMResponse, LLMProviderError
from apps.lessons.ai.generator import generate_daily_lesson


def test_generate_lesson_success():
    fake_json = """
    {
      "summary": "День прошел хорошо. Сделана 1 продажа.",
      "highlights": [{"title": "Отличная презентация", "evidence": "В чате с Клиентом"}],
      "tips": [{"title": "Уточняй бюджет", "why": "Важно", "example": "Как дела?", "action": "Спросить"}],
      "micro_lesson": "Будь внимателен к клиенту."
    }
    """

    class FakeProvider:
        def generate_content(self, *, prompt, response_json=False):
            return LLMResponse(text=fake_json, model_used="gemini-flash", provider="gemini")

    with patch("apps.lessons.ai.generator.get_llm_provider", return_value=FakeProvider()):
        res = generate_daily_lesson("Тест", 10, {})

    assert res["summary"] == "День прошел хорошо. Сделана 1 продажа."
    assert len(res["highlights"]) == 1
    assert len(res["tips"]) == 1
    assert res["micro_lesson"] == "Будь внимателен к клиенту."
    assert res["model_used"] == "gemini-flash"
    assert res["provider"] == "gemini"


def test_generate_lesson_invalid_json_then_valid():
    """First call returns garbage → retry → second call returns valid JSON → ok."""
    valid_json = """
    {
      "summary": "Recovered on retry",
      "highlights": [],
      "tips": [],
      "micro_lesson": "Retry works"
    }
    """

    class FlakyProvider:
        def __init__(self):
            self.calls = 0

        def generate_content(self, *, prompt, response_json=False):
            self.calls += 1
            if self.calls == 1:
                return LLMResponse(text="not json at all", model_used="gemini-flash", provider="gemini")
            return LLMResponse(text=valid_json, model_used="gemini-flash", provider="gemini")

    provider = FlakyProvider()
    with patch("apps.lessons.ai.generator.get_llm_provider", return_value=provider):
        res = generate_daily_lesson("Тест", 10, {})

    assert provider.calls == 2
    assert res["summary"] == "Recovered on retry"
    assert res["micro_lesson"] == "Retry works"


def test_generate_lesson_invalid_json_both_attempts():
    """Both attempts return garbage → LLMProviderError, provider called exactly twice."""

    class AlwaysBadProvider:
        def __init__(self):
            self.calls = 0

        def generate_content(self, *, prompt, response_json=False):
            self.calls += 1
            return LLMResponse(text="still not json", model_used="gemini-flash", provider="gemini")

    provider = AlwaysBadProvider()
    with patch("apps.lessons.ai.generator.get_llm_provider", return_value=provider):
        with pytest.raises(LLMProviderError):
            generate_daily_lesson("Тест", 10, {})

    assert provider.calls == 2

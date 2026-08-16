import pytest
from unittest.mock import patch

from apps.tg_userclient.ai.provider import LLMResponse, LLMProviderError
from apps.lessons.ai.generator import generate_daily_lesson


def test_generate_lesson_v1_legacy_shape_still_parses():
    """Old flat v1 JSON (summary/highlights/tips/micro_lesson) is still accepted.

    Guards against a scenario where an older LLM run returns the pre-v2
    shape — we shouldn't crash, just leave `content` empty and rely on
    the flat fields.
    """
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
    # v1 payload → no v2 content block
    assert res["content"] == {}


def test_generate_lesson_v2_shape_is_parsed_and_mapped():
    """
    New v2 JSON is stored under `content` AND flattened into legacy fields
    so old consumers still render.
    """
    fake_v2 = """
    {
      "greeting_line": "Дилшод, привет.",
      "yesterday_summary": "3 продажи на 15 млн, 12 диалогов, 1 callback пропущен.",
      "main_insight": {"title": "Держи бюджет-вопрос", "text": "Спрашивай бюджет до презентации."},
      "highlights": [{"title": "Хороший темп", "evidence": "3 продажи за смену"}],
      "blockers": [
        {"title": "Молчание после цены", "why": "Клиент замолкает.",
         "example": "Клиент: сколько?\\nОператор: 12 млн"}
      ],
      "practice_today": [
        {"step": "Спроси бюджет", "when": "До показа модели", "how": "Ответь: «Какой бюджет?»"}
      ],
      "micro_lesson": "Бюджет до показа. Всегда.",
      "closing_line": "Удачи."
    }
    """

    class FakeProvider:
        def generate_content(self, *, prompt, response_json=False):
            return LLMResponse(text=fake_v2, model_used="gemini-flash", provider="gemini")

    with patch("apps.lessons.ai.generator.get_llm_provider", return_value=FakeProvider()):
        res = generate_daily_lesson("Дилшод", 10, {"chat_examples": []})

    # v2 content block populated
    assert res["content"]["greeting_line"] == "Дилшод, привет."
    assert res["content"]["yesterday_summary"].startswith("3 продажи")
    assert res["content"]["main_insight"]["title"] == "Держи бюджет-вопрос"
    assert len(res["content"]["blockers"]) == 1
    assert len(res["content"]["practice_today"]) == 1
    assert res["content"]["closing_line"] == "Удачи."

    # Legacy flat fields kept in sync (so back-compat renderers work)
    assert res["summary"] == res["content"]["yesterday_summary"]
    assert len(res["highlights"]) == 1
    assert len(res["tips"]) == 1
    assert res["tips"][0]["example"].startswith("Клиент:")


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

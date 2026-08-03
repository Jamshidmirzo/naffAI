"""
Unit tests for OpenAICompatibleProvider and the per-app factories
get_ai_chat_provider / get_marketing_provider.

Ни одного реального сетевого запроса — httpx.post замокан.
"""

from __future__ import annotations

import json
from unittest.mock import MagicMock, patch

import pytest
from django.test import TestCase, override_settings

from apps.tg_userclient.ai.provider import (
    LLMProviderError,
    LLMRateLimitError,
    MessageDTO,
    NoneProvider,
    OpenAICompatibleProvider,
    get_ai_chat_provider,
    get_marketing_provider,
    get_provider,
)


def _make_response(status_code: int, json_body: dict | None = None, text: str = ""):
    resp = MagicMock()
    resp.status_code = status_code
    if json_body is None:
        resp.json.side_effect = ValueError("no json")
    else:
        resp.json.return_value = json_body
    resp.text = text or (json.dumps(json_body) if json_body is not None else "")
    return resp


_BASE = "https://llm.int.glob.uz/openai"
_KEY = "sk-test-xyz"
_MODEL = "sglang/nvidia/GLM-5.2-NVFP4"


@pytest.mark.django_db
class TestOpenAICompatibleProviderInit(TestCase):
    def test_rejects_empty_base_url(self):
        with self.assertRaises(ValueError):
            OpenAICompatibleProvider(base_url="", api_key=_KEY, model=_MODEL)

    def test_rejects_empty_api_key(self):
        with self.assertRaises(ValueError):
            OpenAICompatibleProvider(base_url=_BASE, api_key="", model=_MODEL)

    def test_rejects_empty_model(self):
        with self.assertRaises(ValueError):
            OpenAICompatibleProvider(base_url=_BASE, api_key=_KEY, model="")

    def test_strips_trailing_slash(self):
        p = OpenAICompatibleProvider(base_url=_BASE + "/", api_key=_KEY, model=_MODEL)
        self.assertEqual(p.base_url, _BASE)


@pytest.mark.django_db
class TestOpenAICompatibleProviderGenerateContent(TestCase):
    @patch("httpx.post")
    def test_generate_content_returns_text_and_model(self, mock_post):
        mock_post.return_value = _make_response(
            200,
            {"choices": [{"message": {"role": "assistant", "content": "hi there"}}]},
        )
        p = OpenAICompatibleProvider(base_url=_BASE, api_key=_KEY, model=_MODEL)
        result = p.generate_content(prompt="say hi", response_json=False)
        self.assertEqual(result.text, "hi there")
        self.assertEqual(result.model_used, _MODEL)
        self.assertEqual(result.provider, "openai_compat")

        # Sanity check the outgoing request.
        args, kwargs = mock_post.call_args
        self.assertEqual(args[0], f"{_BASE}/chat/completions")
        self.assertEqual(kwargs["headers"]["Authorization"], f"Bearer {_KEY}")
        self.assertEqual(kwargs["json"]["model"], _MODEL)
        self.assertNotIn("response_format", kwargs["json"])

    @patch("httpx.post")
    def test_generate_content_sets_json_mode(self, mock_post):
        mock_post.return_value = _make_response(
            200,
            {"choices": [{"message": {"role": "assistant", "content": '{"ok": 1}'}}]},
        )
        p = OpenAICompatibleProvider(base_url=_BASE, api_key=_KEY, model=_MODEL)
        p.generate_content(prompt="x", response_json=True)
        _, kwargs = mock_post.call_args
        self.assertEqual(kwargs["json"]["response_format"], {"type": "json_object"})

    @patch("httpx.post")
    def test_429_raises_rate_limit(self, mock_post):
        mock_post.return_value = _make_response(429, None, text="rate limited")
        p = OpenAICompatibleProvider(base_url=_BASE, api_key=_KEY, model=_MODEL)
        with self.assertRaises(LLMRateLimitError):
            p.generate_content(prompt="x")

    @patch("httpx.post")
    def test_401_raises_provider_error(self, mock_post):
        mock_post.return_value = _make_response(401, None, text="unauthorized")
        p = OpenAICompatibleProvider(base_url=_BASE, api_key=_KEY, model=_MODEL)
        with self.assertRaises(LLMProviderError):
            p.generate_content(prompt="x")

    @patch("httpx.post")
    def test_400_with_json_mode_retries_without_it(self, mock_post):
        first = _make_response(400, None, text="response_format not supported")
        second = _make_response(
            200,
            {"choices": [{"message": {"role": "assistant", "content": "recovered"}}]},
        )
        mock_post.side_effect = [first, second]
        p = OpenAICompatibleProvider(base_url=_BASE, api_key=_KEY, model=_MODEL)
        result = p.generate_content(prompt="x", response_json=True)
        self.assertEqual(result.text, "recovered")
        # Second call should not include response_format.
        second_kwargs = mock_post.call_args_list[1].kwargs
        self.assertNotIn("response_format", second_kwargs["json"])


@pytest.mark.django_db
class TestOpenAICompatibleProviderAnalyzeDialogs(TestCase):
    @patch("httpx.post")
    def test_analyze_dialogs_parses_json(self, mock_post):
        mock_post.return_value = _make_response(
            200,
            {
                "choices": [
                    {
                        "message": {
                            "role": "assistant",
                            "content": '{"quality_score": 77, "summary": "ok", "red_flags": [], "highlights": ["polite"]}',
                        }
                    }
                ]
            },
        )
        p = OpenAICompatibleProvider(base_url=_BASE, api_key=_KEY, model=_MODEL)
        messages = [
            MessageDTO(direction="in", text="Hi", sent_at="2026-07-23T12:00:00Z"),
            MessageDTO(direction="out", text="Hello", sent_at="2026-07-23T12:00:10Z"),
        ]
        result = p.analyze_dialogs(messages=messages, op_name="Op", prompt_version="v1")
        self.assertEqual(result.quality_score, 77)
        self.assertEqual(result.summary, "ok")
        self.assertEqual(result.highlights, ["polite"])
        self.assertEqual(result.model_version, _MODEL)
        self.assertEqual(result.provider, "openai_compat")


@pytest.mark.django_db
class TestOpenAICompatibleProviderQuote(TestCase):
    @patch("httpx.post")
    def test_generate_quote_parses_dict(self, mock_post):
        mock_post.return_value = _make_response(
            200,
            {
                "choices": [
                    {
                        "message": {
                            "role": "assistant",
                            "content": '{"text": "go go", "author": "coach"}',
                        }
                    }
                ]
            },
        )
        p = OpenAICompatibleProvider(base_url=_BASE, api_key=_KEY, model=_MODEL)
        q = p.generate_quote(prompt="motivate me")
        self.assertEqual(q.text, "go go")
        self.assertEqual(q.author, "coach")
        self.assertEqual(q.model_version, _MODEL)


@pytest.mark.django_db
class TestOpenAICompatibleProviderChatWithTools(TestCase):
    @patch("httpx.post")
    def test_chat_returns_plain_text_when_no_tool_calls(self, mock_post):
        mock_post.return_value = _make_response(
            200,
            {"choices": [{"message": {"role": "assistant", "content": "just an answer"}}]},
        )
        p = OpenAICompatibleProvider(base_url=_BASE, api_key=_KEY, model=_MODEL)
        r = p.chat_with_tools(
            history=[{"role": "user", "content": "hi"}],
            tool_specs={},
            system_prompt="you are helpful",
        )
        self.assertEqual(r.text, "just an answer")
        self.assertEqual(r.tool_calls, [])
        self.assertEqual(r.provider, "openai_compat")

        # Verify system prompt injected + user message present.
        payload = mock_post.call_args.kwargs["json"]
        self.assertEqual(payload["messages"][0]["role"], "system")
        self.assertEqual(payload["messages"][0]["content"], "you are helpful")
        self.assertEqual(payload["messages"][1], {"role": "user", "content": "hi"})

    @patch("httpx.post")
    def test_chat_returns_tool_calls(self, mock_post):
        mock_post.return_value = _make_response(
            200,
            {
                "choices": [
                    {
                        "message": {
                            "role": "assistant",
                            "content": None,
                            "tool_calls": [
                                {
                                    "id": "call_x",
                                    "type": "function",
                                    "function": {
                                        "name": "get_leads_count",
                                        "arguments": '{"since": "today"}',
                                    },
                                }
                            ],
                        }
                    }
                ]
            },
        )
        p = OpenAICompatibleProvider(base_url=_BASE, api_key=_KEY, model=_MODEL)
        r = p.chat_with_tools(
            history=[{"role": "user", "content": "leads_count"}],
            tool_specs={
                "get_leads_count": {
                    "description": "counts leads",
                    "parameters": {"type": "object", "properties": {"since": {"type": "string"}}},
                }
            },
        )
        self.assertEqual(r.text, "")
        self.assertEqual(len(r.tool_calls), 1)
        self.assertEqual(r.tool_calls[0].name, "get_leads_count")
        self.assertEqual(r.tool_calls[0].arguments, {"since": "today"})

        # Tools payload was included.
        payload = mock_post.call_args.kwargs["json"]
        self.assertEqual(payload["tools"][0]["function"]["name"], "get_leads_count")

    @patch("httpx.post")
    def test_chat_replays_tool_responses_with_call_ids(self, mock_post):
        mock_post.return_value = _make_response(
            200,
            {"choices": [{"message": {"role": "assistant", "content": "done"}}]},
        )
        p = OpenAICompatibleProvider(base_url=_BASE, api_key=_KEY, model=_MODEL)
        history = [
            {"role": "user", "content": "count leads"},
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [{"name": "get_leads_count", "arguments": {}}],
            },
            {"role": "tool", "content": "42"},
        ]
        p.chat_with_tools(history=history, tool_specs={})
        payload = mock_post.call_args.kwargs["json"]
        # Find tool msg — should have tool_call_id matching the assistant one.
        assistant = next(m for m in payload["messages"] if m["role"] == "assistant")
        tool = next(m for m in payload["messages"] if m["role"] == "tool")
        assistant_tc_id = assistant["tool_calls"][0]["id"]
        self.assertEqual(tool["tool_call_id"], assistant_tc_id)
        self.assertEqual(tool["content"], "42")


@pytest.mark.django_db
class TestGetAiChatProviderFactory(TestCase):
    @override_settings(
        AI_CHAT_LLM_BASE_URL="",
        AI_CHAT_LLM_API_KEY="",
        AI_CHAT_LLM_MODEL="",
        LLM_PROVIDER="none",
    )
    def test_falls_back_to_default_provider_when_empty(self):
        provider = get_ai_chat_provider()
        # Без креденшлов — обычный get_provider(), при LLM_PROVIDER=none = NoneProvider.
        self.assertIsInstance(provider, NoneProvider)
        # sanity: get_provider() возвращает то же самое.
        self.assertIsInstance(get_provider(), NoneProvider)

    @override_settings(
        AI_CHAT_LLM_BASE_URL=_BASE,
        AI_CHAT_LLM_API_KEY=_KEY,
        AI_CHAT_LLM_MODEL=_MODEL,
    )
    def test_returns_openai_compat_when_all_three_set(self):
        provider = get_ai_chat_provider()
        self.assertIsInstance(provider, OpenAICompatibleProvider)
        self.assertEqual(provider.base_url, _BASE)
        self.assertEqual(provider.api_key, _KEY)
        self.assertEqual(provider.model, _MODEL)

    @override_settings(
        AI_CHAT_LLM_BASE_URL=_BASE,
        AI_CHAT_LLM_API_KEY="",
        AI_CHAT_LLM_MODEL=_MODEL,
        LLM_PROVIDER="none",
    )
    def test_partial_creds_fall_back_to_default(self):
        # Не хватает api_key — fallback на get_provider().
        provider = get_ai_chat_provider()
        self.assertIsInstance(provider, NoneProvider)


@pytest.mark.django_db
class TestGetMarketingProviderFactory(TestCase):
    @override_settings(
        MARKETING_LLM_BASE_URL="",
        MARKETING_LLM_API_KEY="",
        MARKETING_LLM_MODEL="",
        LLM_PROVIDER="none",
    )
    def test_falls_back_to_default_provider_when_empty(self):
        provider = get_marketing_provider()
        self.assertIsInstance(provider, NoneProvider)

    @override_settings(
        MARKETING_LLM_BASE_URL=_BASE,
        MARKETING_LLM_API_KEY=_KEY,
        MARKETING_LLM_MODEL=_MODEL,
    )
    def test_returns_openai_compat_when_all_three_set(self):
        provider = get_marketing_provider()
        self.assertIsInstance(provider, OpenAICompatibleProvider)
        self.assertEqual(provider.model, _MODEL)

    @override_settings(
        MARKETING_LLM_BASE_URL=_BASE,
        MARKETING_LLM_API_KEY=_KEY,
        MARKETING_LLM_MODEL="",
        LLM_PROVIDER="none",
    )
    def test_partial_creds_fall_back_to_default(self):
        provider = get_marketing_provider()
        self.assertIsInstance(provider, NoneProvider)

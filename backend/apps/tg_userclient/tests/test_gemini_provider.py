"""
Unit tests for GeminiProvider in apps.tg_userclient.ai.provider.

All Gemini API calls are mocked (no network requests).
"""

from __future__ import annotations

import logging
from unittest.mock import MagicMock, patch

import pytest
from django.test import TestCase, override_settings

from apps.tg_userclient.ai.provider import (
    GeminiProvider,
    LLMProviderError,
    MessageDTO,
    NoneProvider,
    get_llm_provider,
    get_provider,
)


class MockQuotaError(Exception):
    def __init__(self, message: str = "Quota exceeded", code: int = 429):
        super().__init__(message)
        self.code = code


@pytest.mark.django_db
class TestGeminiProvider(TestCase):

    @patch("google.genai.Client")
    def test_gemini_provider_parses_valid_json(self, mock_client_cls):
        mock_client = MagicMock()
        mock_client_cls.return_value = mock_client
        mock_resp = MagicMock()
        mock_resp.text = '{"quality_score": 85, "summary": "Отличный разговор", "red_flags": [], "highlights": ["Вежливый тон"]}'
        mock_client.models.generate_content.return_value = mock_resp

        provider = GeminiProvider(
            api_key="test_api_key",
            model="gemini-3.6-flash",
            fallback_model="gemini-2.5-flash-lite",
        )

        messages = [
            MessageDTO(direction="in", text="Здравствуйте, сколько стоит iPhone?", sent_at="2026-07-23T12:00:00Z"),
            MessageDTO(direction="out", text="Добрый день! 12 000 000 сум", sent_at="2026-07-23T12:01:00Z"),
        ]

        result = provider.analyze_dialogs(messages=messages, op_name="Алишер", prompt_version="v1")

        self.assertEqual(result.quality_score, 85)
        self.assertEqual(result.summary, "Отличный разговор")
        self.assertEqual(result.red_flags, [])
        self.assertEqual(result.highlights, ["Вежливый тон"])
        self.assertEqual(result.model_version, "gemini-3.6-flash")

        # Ensure correct params passed to generate_content
        mock_client.models.generate_content.assert_called_once()
        _, kwargs = mock_client.models.generate_content.call_args
        self.assertEqual(kwargs["model"], "gemini-3.6-flash")
        self.assertEqual(kwargs["config"]["response_mime_type"], "application/json")

    @patch("google.genai.Client")
    def test_gemini_fallback_on_429(self, mock_client_cls):
        mock_client = MagicMock()
        mock_client_cls.return_value = mock_client

        mock_resp_success = MagicMock()
        mock_resp_success.text = '{"quality_score": 70, "summary": "Fallback ok", "red_flags": [], "highlights": []}'

        # First call raises 429 quota error, second call succeeds
        mock_client.models.generate_content.side_effect = [
            MockQuotaError("429 ResourceExhausted", code=429),
            mock_resp_success,
        ]

        provider = GeminiProvider(
            api_key="test_api_key",
            model="gemini-3.6-flash",
            fallback_model="gemini-2.5-flash-lite",
        )

        messages = [
            MessageDTO(direction="in", text="Привет", sent_at="2026-07-23T12:00:00Z"),
        ]

        with self.assertLogs("apps.tg_userclient.ai", level="WARNING") as cm:
            result = provider.analyze_dialogs(messages=messages, op_name="Алишер", prompt_version="v1")

        self.assertEqual(result.quality_score, 70)
        self.assertEqual(result.model_version, "gemini-2.5-flash-lite")
        self.assertEqual(mock_client.models.generate_content.call_count, 2)
        self.assertTrue(any("falling back to gemini-2.5-flash-lite" in log for log in cm.output))

    @patch("google.genai.Client")
    def test_gemini_invalid_json_raises(self, mock_client_cls):
        mock_client = MagicMock()
        mock_client_cls.return_value = mock_client

        mock_resp = MagicMock()
        # Invalid non-JSON text that cannot be recovered by _parse_llm_json dictionary check
        mock_resp.text = "NOT_VALID_JSON_STRUCT"
        mock_client.models.generate_content.return_value = mock_resp

        # Mock _parse_llm_json returning a non-dict to trigger LLMProviderError check
        with patch("apps.tg_userclient.ai.provider._parse_llm_json", return_value="not_a_dict"):
            provider = GeminiProvider(
                api_key="test_api_key",
                model="gemini-3.6-flash",
                fallback_model="gemini-2.5-flash-lite",
            )
            messages = [MessageDTO(direction="in", text="Test", sent_at="2026-07-23T12:00:00Z")]

            with self.assertRaises(LLMProviderError) as ctx:
                provider.analyze_dialogs(messages=messages, op_name="Алишер", prompt_version="v1")
            self.assertIn("gemini returned invalid json", str(ctx.exception))

    @override_settings(
        LLM_PROVIDER="gemini",
        GEMINI_API_KEY="test_api_key",
        GEMINI_MODEL="gemini-3.6-flash",
        GEMINI_FALLBACK_MODEL="gemini-2.5-flash-lite",
    )
    @patch("google.genai.Client")
    def test_get_llm_provider_returns_gemini_when_configured(self, mock_client_cls):
        provider = get_llm_provider()
        self.assertIsInstance(provider, GeminiProvider)
        self.assertIsInstance(get_provider(), GeminiProvider)

    @override_settings(
        LLM_PROVIDER="gemini",
        GEMINI_API_KEY="",
        DEBUG=True,
    )
    def test_get_llm_provider_falls_back_to_none_without_key_in_debug(self):
        provider = get_llm_provider()
        self.assertIsInstance(provider, NoneProvider)

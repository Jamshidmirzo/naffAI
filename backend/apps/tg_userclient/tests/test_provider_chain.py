"""
Unit tests for the multi-provider LLM chain.

Verifies:
- First provider success short-circuits the rest.
- Rate-limit on provider N advances to provider N+1.
- Exhaustion of every provider raises LLMChainExhaustedError.
- Non-rate-limit exceptions also cause fallback.
- LLMResponse.provider records which provider ultimately answered.
- GitHubModelsProvider detects HTTP 429 as LLMRateLimitError.
- _build_chain_from_settings skips slots with a missing token.
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import httpx
import pytest
from django.test import TestCase, override_settings

from apps.tg_userclient.ai.provider import (
    ChatResponse,
    GitHubModelsProvider,
    LLMChainExhaustedError,
    LLMProviderChain,
    LLMRateLimitError,
    LLMResponse,
    NoneProvider,
    QuoteResult,
    _build_chain_from_settings,
)


class StubProvider:
    """Minimal LLMProvider-shaped stub for chain tests."""

    def __init__(self, name: str, *, raises: Exception | None = None):
        self.name = name
        self._raises = raises
        self.calls = 0

    def generate_content(self, *, prompt: str, response_json: bool = False) -> LLMResponse:
        self.calls += 1
        if self._raises is not None:
            raise self._raises
        return LLMResponse(text=f"reply from {self.name}", model_used=self.name, provider=self.name)

    def generate_quote(self, *, prompt: str) -> QuoteResult:
        self.calls += 1
        if self._raises is not None:
            raise self._raises
        return QuoteResult(text=f"quote from {self.name}", model_version=self.name, provider=self.name)

    def chat_with_tools(self, *, history, tool_specs, system_prompt="") -> ChatResponse:
        self.calls += 1
        if self._raises is not None:
            raise self._raises
        return ChatResponse(text=f"chat from {self.name}", model_version=self.name, provider=self.name)

    def analyze_dialogs(self, messages, op_name, prompt_version):  # pragma: no cover
        self.calls += 1
        if self._raises is not None:
            raise self._raises
        raise NotImplementedError


class TestLLMProviderChain(TestCase):
    def test_first_provider_success_short_circuits(self):
        first = StubProvider("first")
        second = StubProvider("second")
        chain = LLMProviderChain([first, second])

        response = chain.generate_content(prompt="hi")

        self.assertEqual(response.provider, "first")
        self.assertEqual(first.calls, 1)
        self.assertEqual(second.calls, 0)

    def test_second_provider_used_when_first_raises_rate_limit(self):
        first = StubProvider("first", raises=LLMRateLimitError("429"))
        second = StubProvider("second")
        chain = LLMProviderChain([first, second])

        with self.assertLogs("apps.tg_userclient.ai", level="WARNING") as cm:
            response = chain.generate_content(prompt="hi")

        self.assertEqual(response.provider, "second")
        self.assertEqual(first.calls, 1)
        self.assertEqual(second.calls, 1)
        self.assertTrue(any("hit rate-limit" in line for line in cm.output))

    def test_all_providers_fail_raises_chain_exhausted(self):
        first = StubProvider("first", raises=LLMRateLimitError("429"))
        second = StubProvider("second", raises=LLMRateLimitError("429"))
        chain = LLMProviderChain([first, second])

        with self.assertRaises(LLMChainExhaustedError):
            chain.generate_content(prompt="hi")

        self.assertEqual(first.calls, 1)
        self.assertEqual(second.calls, 1)

    def test_generic_exception_also_falls_through(self):
        first = StubProvider("first", raises=TimeoutError("network dead"))
        second = StubProvider("second")
        chain = LLMProviderChain([first, second])

        with self.assertLogs("apps.tg_userclient.ai", level="ERROR") as cm:
            response = chain.generate_content(prompt="hi")

        self.assertEqual(response.provider, "second")
        self.assertTrue(any("failed on" in line for line in cm.output))

    def test_response_records_which_provider_answered(self):
        first = StubProvider("gemini", raises=LLMRateLimitError("429"))
        second = StubProvider("github_models")
        chain = LLMProviderChain(
            [first, second],
            name_map={id(first): "gemini(flash)", id(second): "github_models(gpt-4o-mini)"},
        )

        response = chain.generate_quote(prompt="quote please")

        self.assertEqual(response.provider, "github_models")
        self.assertEqual(response.model_version, "github_models")

    def test_chain_requires_at_least_one_provider(self):
        with self.assertRaises(ValueError):
            LLMProviderChain([])


class TestGitHubModelsProviderRateLimit(TestCase):
    def test_github_models_detects_429_status(self):
        provider = GitHubModelsProvider(token="tok", model="openai/gpt-4o-mini")

        response = MagicMock(spec=httpx.Response)
        response.status_code = 429
        response.text = '{"error": {"code": "RateLimitReached"}}'

        with patch("httpx.post", return_value=response):
            with self.assertRaises(LLMRateLimitError) as ctx:
                provider.generate_content(prompt="hello")

        self.assertIn("429", str(ctx.exception))

    def test_github_models_missing_token_raises_valueerror(self):
        with self.assertRaises(ValueError):
            GitHubModelsProvider(token="", model="openai/gpt-4o-mini")

    def test_github_models_generate_content_parses_openai_shape(self):
        provider = GitHubModelsProvider(token="tok", model="openai/gpt-4o-mini")

        fake_response = MagicMock(spec=httpx.Response)
        fake_response.status_code = 200
        fake_response.json.return_value = {
            "choices": [{"message": {"content": "hello from gpt-4o-mini"}}]
        }
        fake_response.text = ""

        with patch("httpx.post", return_value=fake_response):
            result = provider.generate_content(prompt="hi")

        self.assertEqual(result.text, "hello from gpt-4o-mini")
        self.assertEqual(result.provider, "github_models")
        self.assertEqual(result.model_used, "openai/gpt-4o-mini")


class TestChainBuilder(TestCase):
    @override_settings(
        LLM_CHAIN="gemini,github_models_gpt4omini,github_models_deepseek",
        GEMINI_API_KEY="",  # missing → skipped
        GITHUB_MODELS_TOKEN="",  # missing → all github slots skipped
        LLM_CHAIN_MODELS={
            "gemini": "gemini-flash-latest",
            "github_models_gpt4omini": "openai/gpt-4o-mini",
            "github_models_deepseek": "deepseek/deepseek-v3-0324",
        },
    )
    def test_chain_skips_provider_with_missing_token(self):
        result = _build_chain_from_settings()
        # All slots skipped → NoneProvider returned as ultimate fallback.
        self.assertIsInstance(result, NoneProvider)

    @override_settings(
        LLM_CHAIN="github_models_gpt4omini,none",
        GITHUB_MODELS_TOKEN="fake-token",
        LLM_CHAIN_MODELS={
            "github_models_gpt4omini": "openai/gpt-4o-mini",
        },
    )
    def test_chain_builds_when_token_present(self):
        result = _build_chain_from_settings()
        self.assertIsInstance(result, LLMProviderChain)
        # First slot is GitHubModelsProvider, second slot is NoneProvider.
        providers = result.providers
        self.assertEqual(len(providers), 2)
        self.assertIsInstance(providers[0], GitHubModelsProvider)
        self.assertIsInstance(providers[1], NoneProvider)

    @override_settings(LLM_CHAIN="", LLM_CHAIN_MODELS={})
    def test_empty_chain_falls_back_to_none_provider(self):
        result = _build_chain_from_settings()
        self.assertIsInstance(result, NoneProvider)


@pytest.mark.django_db
def test_chain_analyze_dialogs_uses_second_provider_after_first_429():
    from apps.tg_userclient.ai.provider import InsightResult

    first = StubProvider("gemini", raises=LLMRateLimitError("429"))

    class SuccessInsight:
        calls = 0

        def analyze_dialogs(self, messages, op_name, prompt_version):
            SuccessInsight.calls += 1
            return InsightResult(
                quality_score=77,
                summary="ok",
                red_flags=[],
                highlights=[],
                model_version="openai/gpt-4o-mini",
                provider="github_models",
            )

        def generate_content(self, *, prompt, response_json=False):  # pragma: no cover
            return LLMResponse()

        def generate_quote(self, *, prompt):  # pragma: no cover
            return QuoteResult()

        def chat_with_tools(self, *, history, tool_specs, system_prompt=""):  # pragma: no cover
            return ChatResponse()

    second = SuccessInsight()
    chain = LLMProviderChain([first, second])
    result = chain.analyze_dialogs(messages=[], op_name="Test", prompt_version="v1")
    assert result.quality_score == 77
    assert result.provider == "github_models"
    assert SuccessInsight.calls == 1

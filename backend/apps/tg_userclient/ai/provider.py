"""
LLM providers for dialog analysis.

Pluggable via ``settings.LLM_PROVIDER``: ``gemini``, ``openai``, ``anthropic``, ``none``.
The ``none`` provider is a no-op for tests.

Each provider implements ``analyze_dialogs(messages, op_name, prompt_version)``
and returns an ``InsightResult`` dataclass.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol

from django.conf import settings

logger = logging.getLogger("apps.tg_userclient.ai")

PROMPTS_DIR = Path(__file__).parent / "prompts"


class LLMProviderError(RuntimeError):
    pass


@dataclass
class MessageDTO:
    direction: str  # "in" / "out"
    text: str
    sent_at: str  # ISO string


@dataclass
class InsightResult:
    quality_score: int = 0
    summary: str = ""
    red_flags: list[str] = field(default_factory=list)
    highlights: list[str] = field(default_factory=list)
    model_version: str = ""


class LLMProvider(Protocol):
    def analyze_dialogs(
        self,
        messages: list[MessageDTO],
        op_name: str,
        prompt_version: str,
    ) -> InsightResult: ...


def _load_prompt(version: str, op_name: str, dialog_text: str) -> str:
    path = PROMPTS_DIR / f"dialog_{version}.txt"
    template = path.read_text(encoding="utf-8")
    return template.replace("{op_name}", op_name).replace("{dialog}", dialog_text)


def _format_dialog(messages: list[MessageDTO]) -> str:
    lines = []
    for m in messages:
        label = "Клиент" if m.direction == "in" else "Оператор"
        lines.append(f"[{m.sent_at}] {label}: {m.text}")
    return "\n".join(lines)


def _parse_llm_json(raw: str) -> dict:
    """Extract JSON from LLM response, tolerating markdown fences."""
    text = raw.strip()
    if text.startswith("```"):
        # Strip markdown code fences
        lines = text.split("\n")
        lines = [l for l in lines if not l.strip().startswith("```")]
        text = "\n".join(lines)
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        logger.warning("Failed to parse LLM JSON: %s", text[:200])
        return {"quality_score": 0, "summary": text[:500], "red_flags": [], "highlights": []}


def _is_quota_error(exc: Exception) -> bool:
    """Check if exception represents a 429 / ResourceExhausted quota error."""
    code = getattr(exc, "code", None) or getattr(exc, "status_code", None)
    if code == 429:
        return True
    msg = str(exc).lower()
    return "429" in msg or "resourceexhausted" in msg or "quota" in msg


class GeminiProvider:
    """
    Google Gemini via google-genai SDK (AI Studio, not Vertex).
    Primary: settings.GEMINI_MODEL. Fallback on 429/ResourceExhausted:
    settings.GEMINI_FALLBACK_MODEL.
    """

    def __init__(
        self,
        *,
        api_key: str | None = None,
        model: str | None = None,
        fallback_model: str | None = None,
    ) -> None:
        key = api_key or getattr(settings, "GEMINI_API_KEY", "")
        if not key:
            raise ValueError("GEMINI_API_KEY is empty")
        from google import genai

        self._client = genai.Client(api_key=key)
        self._model = model or getattr(settings, "GEMINI_MODEL", "gemini-3.6-flash")
        self._fallback_model = fallback_model or getattr(
            settings, "GEMINI_FALLBACK_MODEL", "gemini-2.5-flash-lite"
        )

    def _call(self, model: str, prompt: str) -> str:
        resp = self._client.models.generate_content(
            model=model,
            contents=prompt,
            config={
                "response_mime_type": "application/json",
                "max_output_tokens": 800,
                "temperature": 0.3,
            },
        )
        return resp.text or ""

    def analyze_dialogs(
        self,
        messages: list[MessageDTO],
        op_name: str,
        prompt_version: str = "v1",
    ) -> InsightResult:
        dialog_text = _format_dialog(messages)
        prompt = _load_prompt(prompt_version, op_name, dialog_text)

        try:
            raw_text = self._call(self._model, prompt)
            model_used = self._model
        except Exception as exc:
            if _is_quota_error(exc):
                logger.warning(
                    "gemini quota hit on %s — falling back to %s",
                    self._model,
                    self._fallback_model,
                )
                try:
                    raw_text = self._call(self._fallback_model, prompt)
                    model_used = self._fallback_model
                except Exception as fb_exc:
                    raise LLMProviderError(f"Gemini fallback model also failed: {fb_exc}") from fb_exc
            else:
                raise LLMProviderError(f"Gemini API call failed: {exc}") from exc

        try:
            data = _parse_llm_json(raw_text)
            if not isinstance(data, dict):
                raise ValueError("Parsed JSON is not a dictionary")
        except Exception as exc:
            raise LLMProviderError(f"gemini returned invalid json: {raw_text[:200]}") from exc

        return InsightResult(
            quality_score=data.get("quality_score", 0),
            summary=data.get("summary", ""),
            red_flags=data.get("red_flags", []),
            highlights=data.get("highlights", []),
            model_version=model_used,
        )


class OpenAIProvider:
    """GPT-4o via OpenAI API."""

    def analyze_dialogs(
        self,
        messages: list[MessageDTO],
        op_name: str,
        prompt_version: str = "v1",
    ) -> InsightResult:
        import httpx

        dialog_text = _format_dialog(messages)
        prompt = _load_prompt(prompt_version, op_name, dialog_text)

        api_key = getattr(settings, "OPENAI_API_KEY", "")
        if not api_key:
            raise RuntimeError("OPENAI_API_KEY not configured")

        resp = httpx.post(
            "https://api.openai.com/v1/chat/completions",
            headers={"Authorization": f"Bearer {api_key}"},
            json={
                "model": "gpt-4o",
                "messages": [{"role": "user", "content": prompt}],
                "temperature": 0.3,
                "response_format": {"type": "json_object"},
            },
            timeout=60,
        )
        resp.raise_for_status()
        content = resp.json()["choices"][0]["message"]["content"]
        data = _parse_llm_json(content)

        return InsightResult(
            quality_score=data.get("quality_score", 0),
            summary=data.get("summary", ""),
            red_flags=data.get("red_flags", []),
            highlights=data.get("highlights", []),
            model_version="gpt-4o",
        )


class AnthropicProvider:
    """Claude via Anthropic API."""

    def analyze_dialogs(
        self,
        messages: list[MessageDTO],
        op_name: str,
        prompt_version: str = "v1",
    ) -> InsightResult:
        import httpx

        dialog_text = _format_dialog(messages)
        prompt = _load_prompt(prompt_version, op_name, dialog_text)

        api_key = getattr(settings, "ANTHROPIC_API_KEY", "")
        if not api_key:
            raise RuntimeError("ANTHROPIC_API_KEY not configured")

        resp = httpx.post(
            "https://api.anthropic.com/v1/messages",
            headers={
                "x-api-key": api_key,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            json={
                "model": "claude-sonnet-4-20250514",
                "max_tokens": 2048,
                "messages": [{"role": "user", "content": prompt}],
            },
            timeout=60,
        )
        resp.raise_for_status()
        content = resp.json()["content"][0]["text"]
        data = _parse_llm_json(content)

        return InsightResult(
            quality_score=data.get("quality_score", 0),
            summary=data.get("summary", ""),
            red_flags=data.get("red_flags", []),
            highlights=data.get("highlights", []),
            model_version="claude-sonnet-4",
        )


class NoneProvider:
    """No-op provider for testing."""

    def analyze_dialogs(
        self,
        messages: list[MessageDTO],
        op_name: str,
        prompt_version: str = "v1",
    ) -> InsightResult:
        return InsightResult(
            quality_score=50,
            summary="Test insight (NoneProvider)",
            red_flags=[],
            highlights=[],
            model_version="none",
        )


def get_provider() -> LLMProvider:
    """Factory: return the configured LLM provider."""
    name = getattr(settings, "LLM_PROVIDER", "none").lower()
    if name == "gemini":
        api_key = getattr(settings, "GEMINI_API_KEY", "")
        if not api_key:
            if getattr(settings, "DEBUG", False):
                logger.warning(
                    "GEMINI_API_KEY is empty while LLM_PROVIDER='gemini'; falling back to NoneProvider"
                )
                return NoneProvider()
            raise ValueError("GEMINI_API_KEY is not configured")
        return GeminiProvider(
            api_key=api_key,
            model=getattr(settings, "GEMINI_MODEL", "gemini-3.6-flash"),
            fallback_model=getattr(settings, "GEMINI_FALLBACK_MODEL", "gemini-2.5-flash-lite"),
        )
    if name == "openai":
        return OpenAIProvider()
    if name == "anthropic":
        return AnthropicProvider()
    return NoneProvider()


get_llm_provider = get_provider

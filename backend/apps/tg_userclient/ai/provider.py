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


@dataclass
class QuoteResult:
    text: str = ""
    author: str = ""
    model_version: str = ""


@dataclass
class ChatToolCall:
    name: str
    arguments: dict


@dataclass
class ChatResponse:
    """
    Result of a `chat_with_tools` step.

    - When ``tool_calls`` is non-empty the assistant asked to invoke one
      or more tools; the caller must run them and feed the results back.
    - When ``text`` is set and ``tool_calls`` is empty the loop is done.
    """
    text: str = ""
    tool_calls: list[ChatToolCall] = field(default_factory=list)
    model_version: str = ""


class LLMProvider(Protocol):
    def analyze_dialogs(
        self,
        messages: list[MessageDTO],
        op_name: str,
        prompt_version: str,
    ) -> InsightResult: ...

    def generate_quote(self, *, prompt: str) -> QuoteResult: ...

    def chat_with_tools(
        self,
        *,
        history: list[dict],
        tool_specs: dict,
        system_prompt: str = "",
    ) -> ChatResponse: ...


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

    def generate_quote(self, *, prompt: str) -> QuoteResult:
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
                    raise LLMProviderError(
                        f"Gemini fallback model also failed: {fb_exc}"
                    ) from fb_exc
            else:
                raise LLMProviderError(f"Gemini API call failed: {exc}") from exc

        data = _parse_llm_json(raw_text)
        return QuoteResult(
            text=data.get("text", "") if isinstance(data, dict) else str(data),
            author=data.get("author", "") if isinstance(data, dict) else "",
            model_version=model_used,
        )

    def chat_with_tools(
        self,
        *,
        history: list[dict],
        tool_specs: dict,
        system_prompt: str = "",
    ) -> ChatResponse:
        """
        Gemini function-calling loop step.

        We assemble the tools as Gemini function declarations, replay the
        conversation, and return either a ``tool_calls`` list (when the
        model asks for a function invocation) or the final ``text``.

        This is intentionally lightweight — one step per call — the outer
        loop in the service is what drives the multi-turn tool dialogue.
        """
        from google.genai import types as gtypes

        # Build function declarations from our TOOLS registry.
        function_declarations = []
        for name, spec in tool_specs.items():
            function_declarations.append(
                gtypes.FunctionDeclaration(
                    name=name,
                    description=spec.get("description", ""),
                    parameters=spec.get("parameters", {"type": "object", "properties": {}}),
                )
            )
        tools = [gtypes.Tool(function_declarations=function_declarations)]

        # Assemble contents from history (list of dicts with role/content).
        contents = []
        for msg in history:
            role = msg["role"]
            if role == "user":
                contents.append(gtypes.Content(role="user", parts=[gtypes.Part(text=msg["content"])]))
            elif role == "assistant":
                contents.append(gtypes.Content(role="model", parts=[gtypes.Part(text=msg["content"])]))
            elif role == "tool":
                # Tool response gets encoded as a user-side function-response part.
                contents.append(
                    gtypes.Content(
                        role="user",
                        parts=[
                            gtypes.Part(
                                function_response=gtypes.FunctionResponse(
                                    name=msg.get("tool_name", "tool"),
                                    response={"result": msg["content"]},
                                )
                            )
                        ],
                    )
                )

        config = gtypes.GenerateContentConfig(
            tools=tools,
            system_instruction=system_prompt or None,
            temperature=0.2,
            max_output_tokens=1500,
        )

        resp = self._client.models.generate_content(
            model=self._model,
            contents=contents,
            config=config,
        )

        tool_calls: list[ChatToolCall] = []
        text_parts: list[str] = []
        try:
            candidates = getattr(resp, "candidates", None) or []
            for candidate in candidates:
                content = getattr(candidate, "content", None)
                parts = getattr(content, "parts", None) if content else None
                for part in parts or []:
                    fc = getattr(part, "function_call", None)
                    if fc:
                        args = dict(getattr(fc, "args", {}) or {})
                        tool_calls.append(ChatToolCall(name=fc.name, arguments=args))
                    else:
                        txt = getattr(part, "text", None)
                        if txt:
                            text_parts.append(txt)
        except Exception as exc:
            logger.warning("Failed to parse Gemini chat response: %s", exc)

        return ChatResponse(
            text="".join(text_parts),
            tool_calls=tool_calls,
            model_version=self._model,
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

    def generate_quote(self, *, prompt: str) -> QuoteResult:
        import httpx

        api_key = getattr(settings, "OPENAI_API_KEY", "")
        if not api_key:
            raise RuntimeError("OPENAI_API_KEY not configured")
        resp = httpx.post(
            "https://api.openai.com/v1/chat/completions",
            headers={"Authorization": f"Bearer {api_key}"},
            json={
                "model": "gpt-4o",
                "messages": [{"role": "user", "content": prompt}],
                "temperature": 0.7,
                "response_format": {"type": "json_object"},
            },
            timeout=60,
        )
        resp.raise_for_status()
        content = resp.json()["choices"][0]["message"]["content"]
        data = _parse_llm_json(content)
        return QuoteResult(
            text=data.get("text", "") if isinstance(data, dict) else str(data),
            author=data.get("author", "") if isinstance(data, dict) else "",
            model_version="gpt-4o",
        )

    def chat_with_tools(
        self,
        *,
        history: list[dict],
        tool_specs: dict,
        system_prompt: str = "",
    ) -> ChatResponse:
        raise LLMProviderError("chat_with_tools not implemented for OpenAIProvider")


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

    def generate_quote(self, *, prompt: str) -> QuoteResult:
        import httpx

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
                "max_tokens": 512,
                "messages": [{"role": "user", "content": prompt}],
            },
            timeout=60,
        )
        resp.raise_for_status()
        content = resp.json()["content"][0]["text"]
        data = _parse_llm_json(content)
        return QuoteResult(
            text=data.get("text", "") if isinstance(data, dict) else str(data),
            author=data.get("author", "") if isinstance(data, dict) else "",
            model_version="claude-sonnet-4",
        )

    def chat_with_tools(
        self,
        *,
        history: list[dict],
        tool_specs: dict,
        system_prompt: str = "",
    ) -> ChatResponse:
        raise LLMProviderError("chat_with_tools not implemented for AnthropicProvider")


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

    def generate_quote(self, *, prompt: str) -> QuoteResult:
        return QuoteResult(
            text="Каждый успешный звонок — маленькая победа.",
            author="",
            model_version="none",
        )

    def chat_with_tools(
        self,
        *,
        history: list[dict],
        tool_specs: dict,
        system_prompt: str = "",
    ) -> ChatResponse:
        """
        Deterministic stub for tests.

        Behaviour: if the last user message contains the literal substring
        "leads_count" (case-insensitive), respond with a get_leads_count
        tool call. If the last message is a `tool` response, echo it back
        as text. Otherwise return a canned reply.
        """
        last = history[-1] if history else {}
        content = (last.get("content") or "").lower()
        if last.get("role") == "user" and "leads_count" in content:
            return ChatResponse(
                text="",
                tool_calls=[ChatToolCall(name="get_leads_count", arguments={})],
                model_version="none",
            )
        if last.get("role") == "tool":
            return ChatResponse(
                text=f"Ответ: {last.get('content', '')}",
                tool_calls=[],
                model_version="none",
            )
        return ChatResponse(
            text="Я — read-only ассистент. Могу считать лиды, продажи и KPI.",
            tool_calls=[],
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

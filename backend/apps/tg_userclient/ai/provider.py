"""
LLM providers for AI features (dialog analysis, AI chat, marketing, quotes).

Pluggable via ``settings.LLM_PROVIDER``:
    - ``chain`` — walk ``settings.LLM_CHAIN`` slots in order, fall back on 429/error.
    - ``gemini`` — Google Gemini (AI Studio, not Vertex).
    - ``github_models`` — GitHub Models (OpenAI-compatible endpoint).
    - ``openai`` / ``anthropic`` — legacy stubs (kept for backward compatibility).
    - ``none`` — deterministic no-op used in tests.

Each provider implements the ``LLMProvider`` Protocol:
    - ``analyze_dialogs`` (batch dialog scoring)
    - ``generate_quote``  (daily motivational quote / marketing summary)
    - ``generate_content`` (raw text generation used by the chain / smoke tests)
    - ``chat_with_tools`` (function-calling loop step for the AI chat)

Every result now carries the ``provider_used`` / ``model_used`` fields so
the UI can badge each response with the model that answered.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

from django.conf import settings

logger = logging.getLogger("apps.tg_userclient.ai")

PROMPTS_DIR = Path(__file__).parent / "prompts"


class LLMProviderError(RuntimeError):
    """Base error for LLM provider failures."""


class LLMRateLimitError(LLMProviderError):
    """
    Provider hit a rate/quota limit (429). The chain uses this as the
    canonical signal to move to the next provider without escalating.
    """


class LLMChainExhaustedError(LLMProviderError):
    """Every provider in the chain refused the request."""


@dataclass
class MessageDTO:
    direction: str  # "in" / "out"
    text: str
    sent_at: str  # ISO string


@dataclass
class LLMResponse:
    """
    Uniform result wrapper for text generation. Every provider must set
    ``provider`` and ``model_used`` so callers can persist / display them.
    """

    text: str = ""
    model_used: str = ""
    provider: str = ""


@dataclass
class InsightResult:
    quality_score: int = 0
    summary: str = ""
    red_flags: list[str] = field(default_factory=list)
    highlights: list[str] = field(default_factory=list)
    model_version: str = ""
    provider: str = ""


@dataclass
class QuoteResult:
    text: str = ""
    author: str = ""
    model_version: str = ""
    provider: str = ""


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
    provider: str = ""


class LLMProvider(Protocol):
    def analyze_dialogs(
        self,
        messages: list[MessageDTO],
        op_name: str,
        prompt_version: str,
    ) -> InsightResult: ...

    def generate_quote(self, *, prompt: str) -> QuoteResult: ...

    def generate_content(self, *, prompt: str, response_json: bool = False) -> LLMResponse: ...

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
        lines = [line for line in lines if not line.strip().startswith("```")]
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
    Primary: settings.GEMINI_MODEL. Internal per-provider fallback on
    429/ResourceExhausted: settings.GEMINI_FALLBACK_MODEL. If both variants
    of Gemini fail with 429, ``LLMRateLimitError`` is raised so the outer
    chain can move to the next provider.
    """

    PROVIDER_NAME = "gemini"

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
        self._model = model or getattr(settings, "GEMINI_MODEL", "gemini-2.5-flash-lite")
        self._fallback_model = fallback_model or getattr(
            settings, "GEMINI_FALLBACK_MODEL", "gemini-2.5-flash-lite"
        )

    def _call(self, model: str, prompt: str, response_json: bool = True) -> str:
        config: dict[str, Any] = {
            "max_output_tokens": 4096,
            "temperature": 0.3,
        }
        if response_json:
            config["response_mime_type"] = "application/json"
        resp = self._client.models.generate_content(
            model=model,
            contents=prompt,
            config=config,
        )
        return resp.text or ""

    def _call_with_internal_fallback(self, prompt: str, *, response_json: bool = True) -> tuple[str, str]:
        """
        Try the primary Gemini model, on 429 fall back to the secondary Gemini
        model. If both fail with 429, raise LLMRateLimitError so the outer
        chain can move to a different provider.
        """
        try:
            raw = self._call(self._model, prompt, response_json=response_json)
            return raw, self._model
        except Exception as exc:
            if not _is_quota_error(exc):
                raise LLMProviderError(f"Gemini API call failed: {exc}") from exc
            logger.warning(
                "gemini quota hit on %s — falling back to %s",
                self._model,
                self._fallback_model,
            )
            try:
                raw = self._call(self._fallback_model, prompt, response_json=response_json)
                return raw, self._fallback_model
            except Exception as fb_exc:
                if _is_quota_error(fb_exc):
                    raise LLMRateLimitError(
                        f"Gemini both models exhausted: {fb_exc}"
                    ) from fb_exc
                raise LLMProviderError(
                    f"Gemini fallback model also failed: {fb_exc}"
                ) from fb_exc

    def generate_content(self, *, prompt: str, response_json: bool = False) -> LLMResponse:
        raw, model_used = self._call_with_internal_fallback(prompt, response_json=response_json)
        return LLMResponse(text=raw, model_used=model_used, provider=self.PROVIDER_NAME)

    def analyze_dialogs(
        self,
        messages: list[MessageDTO],
        op_name: str,
        prompt_version: str = "v1",
    ) -> InsightResult:
        dialog_text = _format_dialog(messages)
        prompt = _load_prompt(prompt_version, op_name, dialog_text)

        raw_text, model_used = self._call_with_internal_fallback(prompt, response_json=True)

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
            provider=self.PROVIDER_NAME,
        )

    def generate_quote(self, *, prompt: str) -> QuoteResult:
        raw_text, model_used = self._call_with_internal_fallback(prompt, response_json=True)

        data = _parse_llm_json(raw_text)
        return QuoteResult(
            text=data.get("text", "") if isinstance(data, dict) else str(data),
            author=data.get("author", "") if isinstance(data, dict) else "",
            model_version=model_used,
            provider=self.PROVIDER_NAME,
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

        contents = []
        for msg in history:
            role = msg["role"]
            content = msg.get("content", "") or ""
            raw_tool_calls = msg.get("tool_calls") or []
            if role == "user":
                contents.append(gtypes.Content(role="user", parts=[gtypes.Part(text=content)]))
            elif role == "assistant":
                # Prefer tool-call parts when the assistant asked for tools;
                # skip empty text-only assistant stubs (Gemini rejects empty
                # parts inside a `model` Content).
                parts: list = []
                if raw_tool_calls:
                    for tc in raw_tool_calls:
                        parts.append(
                            gtypes.Part(
                                function_call=gtypes.FunctionCall(
                                    name=tc.get("name") or "tool",
                                    args=tc.get("arguments") or {},
                                )
                            )
                        )
                if content:
                    parts.append(gtypes.Part(text=content))
                if parts:
                    contents.append(gtypes.Content(role="model", parts=parts))
            elif role == "tool":
                contents.append(
                    gtypes.Content(
                        role="user",
                        parts=[
                            gtypes.Part(
                                function_response=gtypes.FunctionResponse(
                                    name=msg.get("tool_name", "tool"),
                                    response={"result": content},
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

        try:
            resp = self._client.models.generate_content(
                model=self._model,
                contents=contents,
                config=config,
            )
        except Exception as exc:
            if _is_quota_error(exc):
                raise LLMRateLimitError(f"Gemini chat_with_tools 429: {exc}") from exc
            raise LLMProviderError(f"Gemini chat_with_tools failed: {exc}") from exc

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
            provider=self.PROVIDER_NAME,
        )


class GitHubModelsProvider:
    """
    GitHub Models via https://models.github.ai/inference/ .

    OpenAI-compatible chat completions endpoint. Auth: bearer token — the
    output of ``gh auth token`` works, no Copilot Pro required.

    Model names are provider-prefixed: ``openai/gpt-4o-mini``,
    ``deepseek/deepseek-v3-0324``, ``meta/llama-3.3-70b-instruct``, etc.
    """

    PROVIDER_NAME = "github_models"
    BASE_URL = "https://models.github.ai/inference"

    def __init__(self, *, token: str, model: str) -> None:
        if not token:
            raise ValueError("GITHUB_MODELS_TOKEN is empty")
        self._token = token
        self._model = model

    def _post_chat(
        self,
        messages: list[dict],
        *,
        response_json: bool = False,
        temperature: float = 0.3,
        max_tokens: int = 2000,
        tools: list[dict] | None = None,
    ) -> dict:
        import httpx

        payload: dict[str, Any] = {
            "model": self._model,
            "messages": messages,
            "max_tokens": max_tokens,
            "temperature": temperature,
        }
        # OpenAI-compatible json mode. Some non-OpenAI slots (Llama/DeepSeek)
        # may ignore or reject this — we still ask; if the server 400s we
        # retry once without the response_format.
        if response_json:
            payload["response_format"] = {"type": "json_object"}
        if tools:
            payload["tools"] = tools

        try:
            r = httpx.post(
                f"{self.BASE_URL}/chat/completions",
                headers={
                    "Authorization": f"Bearer {self._token}",
                    "Accept": "application/json",
                    "Content-Type": "application/json",
                },
                json=payload,
                timeout=60,
            )
        except httpx.HTTPError as exc:
            raise LLMProviderError(f"GitHub Models network error: {exc}") from exc

        if r.status_code == 429:
            raise LLMRateLimitError(f"GitHub Models 429: {r.text[:200]}")
        if r.status_code == 400 and response_json:
            # Retry without JSON mode (Llama/DeepSeek can dislike it).
            payload.pop("response_format", None)
            r = httpx.post(
                f"{self.BASE_URL}/chat/completions",
                headers={
                    "Authorization": f"Bearer {self._token}",
                    "Accept": "application/json",
                    "Content-Type": "application/json",
                },
                json=payload,
                timeout=60,
            )
            if r.status_code == 429:
                raise LLMRateLimitError(f"GitHub Models 429: {r.text[:200]}")
        if r.status_code >= 400:
            raise LLMProviderError(
                f"GitHub Models {r.status_code}: {r.text[:300]}"
            )
        return r.json()

    def generate_content(self, *, prompt: str, response_json: bool = False) -> LLMResponse:
        data = self._post_chat(
            [{"role": "user", "content": prompt}],
            response_json=response_json,
        )
        text = data["choices"][0]["message"]["content"] or ""
        return LLMResponse(text=text, model_used=self._model, provider=self.PROVIDER_NAME)

    def analyze_dialogs(
        self,
        messages: list[MessageDTO],
        op_name: str,
        prompt_version: str = "v1",
    ) -> InsightResult:
        dialog_text = _format_dialog(messages)
        prompt = _load_prompt(prompt_version, op_name, dialog_text)
        data = self._post_chat(
            [{"role": "user", "content": prompt}],
            response_json=True,
        )
        raw = data["choices"][0]["message"]["content"] or ""
        parsed = _parse_llm_json(raw)
        if not isinstance(parsed, dict):
            raise LLMProviderError(f"GitHub Models returned non-dict json: {raw[:200]}")
        return InsightResult(
            quality_score=parsed.get("quality_score", 0),
            summary=parsed.get("summary", ""),
            red_flags=parsed.get("red_flags", []),
            highlights=parsed.get("highlights", []),
            model_version=self._model,
            provider=self.PROVIDER_NAME,
        )

    def generate_quote(self, *, prompt: str) -> QuoteResult:
        data = self._post_chat(
            [{"role": "user", "content": prompt}],
            response_json=True,
            temperature=0.7,
        )
        raw = data["choices"][0]["message"]["content"] or ""
        parsed = _parse_llm_json(raw)
        if isinstance(parsed, dict):
            return QuoteResult(
                text=parsed.get("text", "") or raw,
                author=parsed.get("author", ""),
                model_version=self._model,
                provider=self.PROVIDER_NAME,
            )
        return QuoteResult(
            text=raw,
            author="",
            model_version=self._model,
            provider=self.PROVIDER_NAME,
        )

    def chat_with_tools(
        self,
        *,
        history: list[dict],
        tool_specs: dict,
        system_prompt: str = "",
    ) -> ChatResponse:
        """
        OpenAI-style tool calling.

        We translate our internal history (roles: user / assistant / tool)
        into OpenAI Chat Completions format. Tool responses become
        ``role: "tool"`` messages with a synthetic ``tool_call_id`` so the
        model can correlate them.
        """
        tools_payload = [
            {
                "type": "function",
                "function": {
                    "name": name,
                    "description": spec.get("description", ""),
                    "parameters": spec.get("parameters", {"type": "object", "properties": {}}),
                },
            }
            for name, spec in tool_specs.items()
        ]

        openai_messages: list[dict] = []
        if system_prompt:
            openai_messages.append({"role": "system", "content": system_prompt})

        # Reconstruct the tool_call_id chain that OpenAI/GH Models require:
        # every `role: tool` message must reference a preceding assistant
        # tool_calls[…].id. We re-issue synthetic ids ("call_0", "call_1"…)
        # per assistant so the pairing is deterministic even after reload.
        pending_ids: list[str] = []
        tool_cursor = 0
        call_counter = 0
        for msg in history:
            role = msg.get("role")
            content = msg.get("content", "") or ""
            raw_tool_calls = msg.get("tool_calls") or []
            if role == "user":
                openai_messages.append({"role": "user", "content": content})
                pending_ids = []
                tool_cursor = 0
            elif role == "assistant":
                if raw_tool_calls:
                    # Assistant asked for one or more tool invocations.
                    tc_list = []
                    pending_ids = []
                    for tc in raw_tool_calls:
                        name = tc.get("name") or "tool"
                        args = tc.get("arguments") or {}
                        cid = f"call_{call_counter}"
                        call_counter += 1
                        pending_ids.append(cid)
                        tc_list.append(
                            {
                                "id": cid,
                                "type": "function",
                                "function": {
                                    "name": name,
                                    "arguments": json.dumps(args),
                                },
                            }
                        )
                    openai_messages.append(
                        {
                            "role": "assistant",
                            "content": content or None,
                            "tool_calls": tc_list,
                        }
                    )
                    tool_cursor = 0
                elif content:
                    openai_messages.append({"role": "assistant", "content": content})
                    pending_ids = []
                    tool_cursor = 0
            elif role == "tool":
                # Match tool responses to the pending assistant's tool_calls
                # in order. If we somehow lost the parent (e.g. old history
                # written before this fix), drop the orphan rather than send
                # a malformed payload the server will reject.
                if tool_cursor < len(pending_ids):
                    openai_messages.append(
                        {
                            "role": "tool",
                            "tool_call_id": pending_ids[tool_cursor],
                            "content": content,
                        }
                    )
                    tool_cursor += 1

        data = self._post_chat(
            openai_messages,
            response_json=False,
            temperature=0.2,
            max_tokens=1500,
            tools=tools_payload or None,
        )

        choice = data["choices"][0]
        message = choice.get("message") or {}
        text = message.get("content") or ""
        tool_calls_raw = message.get("tool_calls") or []
        tool_calls: list[ChatToolCall] = []
        for tc in tool_calls_raw:
            fn = tc.get("function") or {}
            name = fn.get("name") or "tool"
            raw_args = fn.get("arguments") or "{}"
            try:
                args = json.loads(raw_args) if isinstance(raw_args, str) else dict(raw_args)
            except json.JSONDecodeError:
                args = {}
            tool_calls.append(ChatToolCall(name=name, arguments=args))

        return ChatResponse(
            text=text,
            tool_calls=tool_calls,
            model_version=self._model,
            provider=self.PROVIDER_NAME,
        )


class OpenAIProvider:
    """Legacy stub — kept for backward compatibility with older env configs."""

    PROVIDER_NAME = "openai"

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
        if resp.status_code == 429:
            raise LLMRateLimitError(f"OpenAI 429: {resp.text[:200]}")
        resp.raise_for_status()
        content = resp.json()["choices"][0]["message"]["content"]
        data = _parse_llm_json(content)

        return InsightResult(
            quality_score=data.get("quality_score", 0),
            summary=data.get("summary", ""),
            red_flags=data.get("red_flags", []),
            highlights=data.get("highlights", []),
            model_version="gpt-4o",
            provider=self.PROVIDER_NAME,
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
        if resp.status_code == 429:
            raise LLMRateLimitError(f"OpenAI 429: {resp.text[:200]}")
        resp.raise_for_status()
        content = resp.json()["choices"][0]["message"]["content"]
        data = _parse_llm_json(content)
        return QuoteResult(
            text=data.get("text", "") if isinstance(data, dict) else str(data),
            author=data.get("author", "") if isinstance(data, dict) else "",
            model_version="gpt-4o",
            provider=self.PROVIDER_NAME,
        )

    def generate_content(self, *, prompt: str, response_json: bool = False) -> LLMResponse:
        raise LLMProviderError("generate_content not implemented for OpenAIProvider")

    def chat_with_tools(
        self,
        *,
        history: list[dict],
        tool_specs: dict,
        system_prompt: str = "",
    ) -> ChatResponse:
        raise LLMProviderError("chat_with_tools not implemented for OpenAIProvider")


class AnthropicProvider:
    """Legacy stub — kept for backward compatibility with older env configs."""

    PROVIDER_NAME = "anthropic"

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
        if resp.status_code == 429:
            raise LLMRateLimitError(f"Anthropic 429: {resp.text[:200]}")
        resp.raise_for_status()
        content = resp.json()["content"][0]["text"]
        data = _parse_llm_json(content)

        return InsightResult(
            quality_score=data.get("quality_score", 0),
            summary=data.get("summary", ""),
            red_flags=data.get("red_flags", []),
            highlights=data.get("highlights", []),
            model_version="claude-sonnet-4",
            provider=self.PROVIDER_NAME,
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
        if resp.status_code == 429:
            raise LLMRateLimitError(f"Anthropic 429: {resp.text[:200]}")
        resp.raise_for_status()
        content = resp.json()["content"][0]["text"]
        data = _parse_llm_json(content)
        return QuoteResult(
            text=data.get("text", "") if isinstance(data, dict) else str(data),
            author=data.get("author", "") if isinstance(data, dict) else "",
            model_version="claude-sonnet-4",
            provider=self.PROVIDER_NAME,
        )

    def generate_content(self, *, prompt: str, response_json: bool = False) -> LLMResponse:
        raise LLMProviderError("generate_content not implemented for AnthropicProvider")

    def chat_with_tools(
        self,
        *,
        history: list[dict],
        tool_specs: dict,
        system_prompt: str = "",
    ) -> ChatResponse:
        raise LLMProviderError("chat_with_tools not implemented for AnthropicProvider")


class NoneProvider:
    """No-op provider for tests."""

    PROVIDER_NAME = "none"

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
            provider=self.PROVIDER_NAME,
        )

    def generate_quote(self, *, prompt: str) -> QuoteResult:
        return QuoteResult(
            text="Каждый успешный звонок — маленькая победа.",
            author="",
            model_version="none",
            provider=self.PROVIDER_NAME,
        )

    def generate_content(self, *, prompt: str, response_json: bool = False) -> LLMResponse:
        return LLMResponse(
            text="stub",
            model_used="none",
            provider=self.PROVIDER_NAME,
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
                provider=self.PROVIDER_NAME,
            )
        if last.get("role") == "tool":
            return ChatResponse(
                text=f"Ответ: {last.get('content', '')}",
                tool_calls=[],
                model_version="none",
                provider=self.PROVIDER_NAME,
            )
        return ChatResponse(
            text="Я — read-only ассистент. Могу считать лиды, продажи и KPI.",
            tool_calls=[],
            model_version="none",
            provider=self.PROVIDER_NAME,
        )


class LLMProviderChain:
    """
    Ordered chain of providers with automatic fallback.

    Each proxied call walks the list in order. On ``LLMRateLimitError`` the
    chain silently advances to the next provider. On any other exception it
    logs at ERROR level and also advances (so a broken provider does not
    block the whole feature). When every provider refuses, the last error
    is wrapped in ``LLMChainExhaustedError`` for the caller.

    The chain does not implement Protocol methods with a fixed signature —
    it delegates via ``_call``. All callers that use ``.chat_with_tools()``
    / ``.generate_quote()`` etc. on ``LLMProvider`` continue to work.
    """

    def __init__(
        self,
        providers: list[LLMProvider],
        *,
        name_map: dict[int, str] | None = None,
    ) -> None:
        if not providers:
            raise ValueError("LLMProviderChain requires at least 1 provider")
        self._providers = providers
        # Keyed by id() so we don't force providers to be hashable.
        self._name_map = name_map or {}

    @property
    def providers(self) -> list[LLMProvider]:
        return list(self._providers)

    def _label(self, provider: LLMProvider) -> str:
        return self._name_map.get(id(provider), type(provider).__name__)

    def _call(self, method_name: str, /, **kwargs: Any) -> Any:
        last_error: Exception | None = None
        for provider in self._providers:
            label = self._label(provider)
            try:
                result = getattr(provider, method_name)(**kwargs)
                logger.info(
                    "llm.chain: %s succeeded with %s",
                    method_name,
                    label,
                )
                return result
            except LLMRateLimitError as exc:
                logger.warning(
                    "llm.chain: %s hit rate-limit on %s, falling back (%s)",
                    method_name,
                    label,
                    exc,
                )
                last_error = exc
                continue
            except LLMChainExhaustedError:
                # A nested chain — propagate.
                raise
            except Exception as exc:
                logger.error(
                    "llm.chain: %s failed on %s: %s",
                    method_name,
                    label,
                    exc,
                )
                last_error = exc
                continue
        raise LLMChainExhaustedError(
            f"All providers exhausted for {method_name}: {last_error}"
        )

    def generate_content(self, **kwargs: Any) -> LLMResponse:
        return self._call("generate_content", **kwargs)

    def generate_quote(self, **kwargs: Any) -> QuoteResult:
        return self._call("generate_quote", **kwargs)

    def chat_with_tools(self, **kwargs: Any) -> ChatResponse:
        return self._call("chat_with_tools", **kwargs)

    def analyze_dialogs(self, **kwargs: Any) -> InsightResult:
        return self._call("analyze_dialogs", **kwargs)


def _default_chain_models() -> dict[str, str]:
    """
    Fallback dict when `settings.LLM_CHAIN_MODELS` is not defined (older env).
    Keeps the factory usable in tests and legacy configs.
    """
    # NB: DeepSeek slot dropped — the GH Models catalog id
    # `deepseek/deepseek-v3-0324` currently returns HTTP 400 "unknown
    # model" (looks like the endpoint strips the vendor prefix), so the
    # slot poisoned the chain. Add it back after GH restores it.
    return {
        "gemini": getattr(settings, "GEMINI_MODEL", "gemini-2.5-flash-lite"),
        "github_models_gpt4omini": "openai/gpt-4o-mini",
        "github_models_llama": "meta/llama-3.3-70b-instruct",
        "github_models_gpt41mini": "openai/gpt-4.1-mini",
    }


def _build_chain_from_settings() -> LLMProvider:
    """
    Parse ``settings.LLM_CHAIN`` (comma-separated slot names) and build an
    ``LLMProviderChain``. Slots that cannot be instantiated (missing token,
    unknown name) are skipped with an INFO/WARNING log so the chain
    degrades gracefully. If no slot instantiates, returns ``NoneProvider``.
    """
    raw = getattr(settings, "LLM_CHAIN", "") or ""
    slots = [s.strip() for s in raw.split(",") if s.strip()]
    if not slots:
        return NoneProvider()

    chain_models = getattr(settings, "LLM_CHAIN_MODELS", None) or _default_chain_models()

    providers: list[LLMProvider] = []
    name_map: dict[int, str] = {}

    for slot in slots:
        model = chain_models.get(slot)
        provider: LLMProvider | None = None
        try:
            if slot.startswith("gemini"):
                provider = GeminiProvider(
                    api_key=getattr(settings, "GEMINI_API_KEY", ""),
                    model=model or getattr(settings, "GEMINI_MODEL", "gemini-flash-latest"),
                    fallback_model=getattr(settings, "GEMINI_FALLBACK_MODEL", "gemini-2.5-flash-lite"),
                )
            elif slot.startswith("github_models"):
                if not model:
                    logger.warning("llm.chain: no model configured for slot '%s' — skipping", slot)
                    continue
                provider = GitHubModelsProvider(
                    token=getattr(settings, "GITHUB_MODELS_TOKEN", ""),
                    model=model,
                )
            elif slot == "openai":
                provider = OpenAIProvider()
            elif slot == "anthropic":
                provider = AnthropicProvider()
            elif slot == "none":
                provider = NoneProvider()
            else:
                logger.warning("llm.chain: unknown slot '%s' — skipping", slot)
                continue
        except ValueError as exc:
            # Missing token / key — non-fatal, just skip the slot.
            logger.info("llm.chain: skipping slot '%s': %s", slot, exc)
            continue
        except Exception as exc:  # noqa: BLE001
            logger.warning("llm.chain: failed to build slot '%s': %s", slot, exc)
            continue

        providers.append(provider)
        name_map[id(provider)] = f"{slot}({model})" if model else slot

    if not providers:
        return NoneProvider()
    return LLMProviderChain(providers, name_map=name_map)


def get_provider() -> LLMProvider:
    """Factory: return the configured LLM provider (or chain)."""
    name = getattr(settings, "LLM_PROVIDER", "none").lower()
    if name == "chain":
        return _build_chain_from_settings()
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
            model=getattr(settings, "GEMINI_MODEL", "gemini-2.5-flash-lite"),
            fallback_model=getattr(settings, "GEMINI_FALLBACK_MODEL", "gemini-2.5-flash-lite"),
        )
    if name == "github_models":
        token = getattr(settings, "GITHUB_MODELS_TOKEN", "")
        if not token:
            if getattr(settings, "DEBUG", False):
                logger.warning(
                    "GITHUB_MODELS_TOKEN is empty while LLM_PROVIDER='github_models'; falling back to NoneProvider"
                )
                return NoneProvider()
            raise ValueError("GITHUB_MODELS_TOKEN is not configured")
        default_model = _default_chain_models()["github_models_gpt4omini"]
        model = getattr(settings, "LLM_CHAIN_MODELS", {}).get(
            "github_models_gpt4omini", default_model
        )
        return GitHubModelsProvider(token=token, model=model)
    if name == "openai":
        return OpenAIProvider()
    if name == "anthropic":
        return AnthropicProvider()
    return NoneProvider()


get_llm_provider = get_provider


def get_provider_by_key(key: str) -> LLMProvider:
    """
    Build a single provider identified by a chain-slot key from
    ``LLM_CHAIN_MODELS`` (e.g. ``"gemini"``, ``"github_models_gpt4omini"``).
    Bypasses the full chain — useful when the UI lets the user pick a
    specific model. Falls back to ``NoneProvider`` if creds are missing.
    """
    if not key:
        return get_provider()
    chain_models = getattr(settings, "LLM_CHAIN_MODELS", None) or _default_chain_models()
    model = chain_models.get(key)
    try:
        if key.startswith("gemini"):
            api_key = getattr(settings, "GEMINI_API_KEY", "")
            if not api_key:
                return NoneProvider()
            return GeminiProvider(
                api_key=api_key,
                model=model or getattr(settings, "GEMINI_MODEL", "gemini-flash-latest"),
                fallback_model=getattr(settings, "GEMINI_FALLBACK_MODEL", "gemini-2.5-flash-lite"),
            )
        if key.startswith("github_models"):
            token = getattr(settings, "GITHUB_MODELS_TOKEN", "")
            if not token or not model:
                return NoneProvider()
            return GitHubModelsProvider(token=token, model=model)
    except Exception as exc:  # noqa: BLE001
        logger.warning("llm.by_key: could not build '%s': %s", key, exc)
    return NoneProvider()


def list_available_providers() -> list[dict[str, str]]:
    """
    UI-facing list of provider slots. Only slots with valid creds are
    included, so the front-end selector never shows dead options.
    """
    chain_models = getattr(settings, "LLM_CHAIN_MODELS", None) or _default_chain_models()
    labels = {
        "gemini": "Gemini Flash",
        "github_models_gpt4omini": "GPT-4o mini",
        "github_models_gpt41mini": "GPT-4.1 mini",
        "github_models_deepseek": "DeepSeek v3",
        "github_models_llama": "Llama 3.3 70B",
    }
    gemini_ok = bool(getattr(settings, "GEMINI_API_KEY", ""))
    gh_ok = bool(getattr(settings, "GITHUB_MODELS_TOKEN", ""))
    out: list[dict[str, str]] = []
    for key, model in chain_models.items():
        if key.startswith("gemini") and not gemini_ok:
            continue
        if key.startswith("github_models") and not gh_ok:
            continue
        out.append({"key": key, "label": labels.get(key, key), "model": model})
    return out

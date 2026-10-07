"""
LLM client — OpenAI-compatible endpoint (GLM / Zhipu / Z.ai / any proxy).

Design:
- One ``synthesize()`` entry-point. Services pick a ``channel`` ("briefing",
  "weekly", "alert") and we map it to a model from settings.
- If ``ROP_LLM_API_KEY`` is empty or the real call raises, we fall back to
  ``synthesize_stub`` so smoke tests + TG push keep working without a key.
  Deterministic stub, never raises.
- GLM-specific context caching (base_url-dependent) is intentionally NOT
  wired in MVP — a single-line change in ``_call()`` adds it when the user
  settles on a provider.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from django.conf import settings

logger = logging.getLogger("apps.rop_agent.llm")

_CLIENT = None


def _resolve_model(channel: str) -> str:
    default = getattr(settings, "ROP_LLM_MODEL", "") or "glm-4-plus"
    if channel == "weekly":
        return getattr(settings, "ROP_LLM_MODEL_WEEKLY", "") or default
    if channel == "alert":
        return getattr(settings, "ROP_LLM_MODEL_ALERT", "") or default
    return default


def _extra_headers() -> dict[str, str]:
    """
    Parse ``ROP_LLM_EXTRA_HEADERS`` (JSON string) for providers that use
    non-standard auth (e.g. Bifrost proxy expects ``x-bf-vk: sk-bf-...``
    instead of ``Authorization: Bearer``). Empty / malformed → ``{}``.
    """
    raw = getattr(settings, "ROP_LLM_EXTRA_HEADERS", "") or ""
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
        if isinstance(parsed, dict):
            return {str(k): str(v) for k, v in parsed.items()}
    except Exception as exc:
        logger.warning("ROP_LLM_EXTRA_HEADERS parse failed: %s", exc)
    return {}


def _client():
    """Lazy OpenAI-compatible client. Returns ``None`` if not configured."""
    global _CLIENT
    if _CLIENT is not None:
        return _CLIENT
    api_key = getattr(settings, "ROP_LLM_API_KEY", "") or ""
    base_url = getattr(settings, "ROP_LLM_BASE_URL", "") or ""
    if not api_key or not base_url:
        return None
    try:
        from openai import OpenAI  # type: ignore[import-not-found]
    except Exception as exc:
        logger.warning("openai SDK not available: %s", exc)
        return None
    try:
        _CLIENT = OpenAI(
            api_key=api_key,
            base_url=base_url,
            timeout=getattr(settings, "ROP_LLM_TIMEOUT_SECONDS", 45),
            default_headers=_extra_headers() or None,
        )
    except Exception as exc:
        logger.warning("OpenAI client init failed: %s", exc)
        return None
    return _CLIENT


def _reasoning_effort_for(channel: str) -> str:
    """
    Per-channel reasoning budget. GLM-5.3 (and other OpenAI-compatible
    reasoning models) accept ``reasoning_effort`` ∈ {minimal, low, medium, high}.

    Default = minimal for everything except weekly scorecard (gets medium —
    worth a bit more deliberation once a week). Set ``ROP_LLM_REASONING_EFFORT``
    to override the default; set to ``none`` to drop the field entirely for
    providers that reject unknown params.
    """
    override = getattr(settings, "ROP_LLM_REASONING_EFFORT", "") or ""
    if override:
        return override
    if channel == "weekly":
        return "medium"
    return "minimal"


def synthesize(
    system_prompt: str,
    user_payload: str,
    *,
    channel: str = "briefing",
    max_tokens: int = 1200,
    temperature: float = 0.5,
) -> dict[str, Any]:
    """Produce a text synthesis via LLM. Never raises — falls back to stub."""
    client = _client()
    if client is None:
        return synthesize_stub(system_prompt, user_payload, channel=channel)
    model = _resolve_model(channel)
    extra_body: dict[str, Any] = {}
    effort = _reasoning_effort_for(channel)
    if effort and effort.lower() != "none":
        extra_body["reasoning_effort"] = effort
    try:
        resp = client.chat.completions.create(
            model=model,
            max_tokens=max_tokens,
            temperature=temperature,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_payload},
            ],
            extra_body=extra_body or None,
        )
        text = (resp.choices[0].message.content or "").strip()
        usage = getattr(resp, "usage", None)
        return {
            "text": text or "[LLM bo'sh javob qaytardi]",
            "tokens_in": getattr(usage, "prompt_tokens", 0) if usage else 0,
            "tokens_out": getattr(usage, "completion_tokens", 0) if usage else 0,
            "model": getattr(resp, "model", model) or model,
        }
    except Exception as exc:
        logger.exception("LLM call failed (channel=%s model=%s): %s", channel, model, exc)
        return synthesize_stub(system_prompt, user_payload, channel=channel, error=str(exc))


def synthesize_stub(
    system_prompt: str,
    user_payload: str,
    *,
    channel: str = "briefing",
    error: str | None = None,
) -> dict[str, Any]:
    """Deterministic placeholder — safe when no key / provider is down."""
    header = {
        "briefing": "📝 <i>[STUB] LLM konfiguratsiya qilinmagan — brifing matni keyin.</i>",
        "weekly": "📝 <i>[STUB] Weekly scorecard — LLM ulanmagan.</i>",
        "alert": "📝 <i>[STUB] alert matni.</i>",
    }.get(channel, "📝 <i>[STUB] LLM javob yo'q.</i>")
    note = f"\n<code>LLM error: {error}</code>" if error else ""
    return {
        "text": header + note,
        "tokens_in": 0,
        "tokens_out": 0,
        "model": "stub",
    }

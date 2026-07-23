"""
Morning greetings — one AI-generated quote per (day, language) plus a
per-operator "shown today" flag.

- ``get_or_create_daily_quote(language)`` — returns the cached row or
  generates a new one via the configured LLM provider.
- ``mark_greeting_shown(operator)`` — records that this operator saw
  today's quote.
- If the LLM call fails, we return a static fallback so the UI never
  breaks. We do NOT persist the fallback (so tomorrow retries).
"""

from __future__ import annotations

import datetime as dt
import logging
from pathlib import Path

from django.db import transaction
from django.utils import timezone

from apps.operators.models import Operator
from apps.tg_userclient.ai.provider import QuoteResult, get_llm_provider

from .models import DailyGreetingShown, DailyQuote

logger = logging.getLogger("apps.greetings")

PROMPTS_DIR = Path(__file__).parent / "prompts"
SUPPORTED_LANGUAGES = ("ru", "uz")
DEFAULT_LANGUAGE = "ru"

STATIC_FALLBACKS: dict[str, tuple[str, str]] = {
    "ru": ("Успех — это сумма маленьких усилий, повторяемых день за днём.", "Роберт Кольер"),
    "uz": ("Muvaffaqiyat — kunlik kichik harakatlarning yig'indisi.", "Robert Kolyer"),
}


def _load_prompt(language: str) -> str:
    lang = language if language in SUPPORTED_LANGUAGES else DEFAULT_LANGUAGE
    return (PROMPTS_DIR / f"{lang}.txt").read_text(encoding="utf-8")


def _normalize_language(language: str | None) -> str:
    if not language:
        return DEFAULT_LANGUAGE
    lang = language.split("-")[0].lower()
    return lang if lang in SUPPORTED_LANGUAGES else DEFAULT_LANGUAGE


@transaction.atomic
def get_or_create_daily_quote(*, language: str, today: dt.date | None = None) -> DailyQuote:
    """
    Return today's quote for the given language, generating and caching
    if missing. Falls back to a static quote if the LLM provider errors
    (without persisting the fallback so tomorrow will retry).
    """
    today = today or timezone.localdate()
    lang = _normalize_language(language)

    existing = DailyQuote.objects.filter(quote_date=today, language=lang).first()
    if existing:
        return existing

    provider = get_llm_provider()
    prompt = _load_prompt(lang)

    try:
        result = provider.generate_quote(prompt=prompt)
    except Exception as exc:
        logger.warning("LLM generate_quote failed: %s — using static fallback", exc)
        text, author = STATIC_FALLBACKS.get(lang, STATIC_FALLBACKS[DEFAULT_LANGUAGE])
        # Return a transient QuoteResult — we do NOT persist a fallback so
        # the next request will retry the LLM. Give it a synthetic date so
        # the caller can still render.
        return DailyQuote(
            quote_date=today,
            language=lang,
            text=text,
            author=author,
            generated_by_model="fallback",
        )

    if not result.text.strip():
        text, author = STATIC_FALLBACKS.get(lang, STATIC_FALLBACKS[DEFAULT_LANGUAGE])
        return DailyQuote(
            quote_date=today,
            language=lang,
            text=text,
            author=author,
            generated_by_model="fallback",
        )

    return DailyQuote.objects.create(
        quote_date=today,
        language=lang,
        text=result.text.strip(),
        author=(result.author or "").strip(),
        generated_by_model=result.model_version or "unknown",
    )


def mark_greeting_shown(*, operator: Operator, today: dt.date | None = None) -> None:
    today = today or timezone.localdate()
    DailyGreetingShown.objects.get_or_create(operator=operator, date=today)


__all__ = [
    "DEFAULT_LANGUAGE",
    "SUPPORTED_LANGUAGES",
    "QuoteResult",
    "get_or_create_daily_quote",
    "mark_greeting_shown",
]

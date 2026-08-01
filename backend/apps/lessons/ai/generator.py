import json
import logging
from pathlib import Path

from apps.tg_userclient.ai.provider import (
    LLMChainExhaustedError,
    LLMProviderError,
    get_llm_provider,
)

logger = logging.getLogger("apps.lessons.ai")


def _fallback_lesson(name: str, facts: dict) -> dict:
    """
    Deterministic lesson built straight from `collect_yesterday_facts`
    — used when every LLM provider is down (Gemini free-tier exhausted,
    GH Models retirement brownout, etc.). Not as poetic as an LLM
    write-up but it beats a 404 for the operator: they still see
    yesterday's numbers, the streak, and 2-3 concrete tips derived
    from the same signals the LLM would have used.
    """
    sales = facts.get("sales", {})
    dialogs = facts.get("dialogs", {})
    callbacks = facts.get("callbacks", {})
    leads = facts.get("leads", {})
    ctx = facts.get("context", {})

    cnt = int(sales.get("count") or 0)
    rev = int(sales.get("revenue") or 0)
    avg = int(sales.get("avg_check") or 0)
    won = int(leads.get("won") or 0)
    lost = int(leads.get("lost") or 0)
    dlg = int(dialogs.get("count") or 0)
    qs = dialogs.get("avg_quality_score")
    missed = int(callbacks.get("missed") or 0)
    dr = sales.get("delta_revenue") or 0
    dc = sales.get("delta_count") or 0

    highlights: list[str] = []
    if cnt:
        highlights.append(f"{cnt} продаж на {rev:,} сум (средний чек {avg:,} сум)")
    if won:
        highlights.append(f"Закрыто {won} лидов в won")
    if dlg:
        highlights.append(
            f"Диалогов в TG: {dlg}" + (f", средняя оценка {qs}" if qs is not None else "")
        )

    tips: list[str] = []
    if missed > 0:
        tips.append(f"Пропущено callback: {missed} — не забывай нажимать «Прозвонил».")
    if lost and won and lost > won:
        tips.append(f"Потерь ({lost}) больше чем продаж ({won}) — работай над возражениями.")
    if dc < 0:
        tips.append(f"Сегодня продаж на {abs(dc)} меньше, чем позавчера — держи ритм.")
    if not tips:
        tips.append("Продолжай в том же духе — стабильность важнее рывков.")

    if cnt:
        summary = (
            f"{name}, вчера ты сделал {cnt} продаж на {rev:,} сум"
            + (f" ({'+' if dr >= 0 else ''}{dr:,} к позавчера)" if dr else "")
            + "."
        )
    elif dlg:
        summary = f"{name}, вчера продаж не было, но {dlg} диалогов в TG — контакт есть, время закрывать."
    else:
        summary = f"{name}, вчера тихо. Сегодня время наверстать."

    micro = (
        "Правило дня: перед каждой продажей вспомни, что клиент купит не телефон, "
        "а решение своей задачи. Задай один вопрос про его сценарий использования."
    )
    return {
        "summary": summary,
        "highlights": highlights or ["Данных за вчера мало"],
        "tips": tips,
        "micro_lesson": micro,
        "model_used": "fallback",
        "provider": "fallback",
    }

PROMPTS_DIR = Path(__file__).parent / "prompts"

# One retry on JSON garbage — LLMs are non-deterministic, second time
# they often respond cleanly. Two total attempts (initial + retry).
MAX_JSON_ATTEMPTS = 2


def _parse_lesson_json(text: str) -> dict:
    """Strip fenced code blocks and parse into a dict. Raises ValueError on failure."""
    cleaned = (text or "").strip()
    if cleaned.startswith("```"):
        lines = cleaned.split("\n")
        lines = [line for line in lines if not line.strip().startswith("```")]
        cleaned = "\n".join(lines)
    data = json.loads(cleaned)  # raises JSONDecodeError → ValueError subclass
    if not isinstance(data, dict):
        raise ValueError("LLM response is not a JSON object")
    return data


def generate_daily_lesson(name: str, tenure_days: int, facts: dict) -> dict:
    """
    Generate daily lesson content using the configured LLM provider.

    Retries once on garbage JSON: LLM responses are non-deterministic and
    the same prompt can produce valid JSON on the second try. Provider-side
    errors (network, quota, etc.) are re-raised as ``LLMProviderError``
    without retry — the outer command handler will record the failure.
    """
    provider = get_llm_provider()

    prompt_path = PROMPTS_DIR / "daily_lesson_v1.md"
    template = prompt_path.read_text(encoding="utf-8")

    chat_examples_str = json.dumps(facts.get("chat_examples", []), ensure_ascii=False, indent=2)
    clean_facts = {k: v for k, v in facts.items() if k != "chat_examples"}
    facts_str = json.dumps(clean_facts, ensure_ascii=False, indent=2)

    prompt = (
        template.replace("{name}", name)
        .replace("{tenure_days}", str(tenure_days))
        .replace("{facts}", facts_str)
        .replace("{chat_examples}", chat_examples_str)
    )

    last_bad_snippet: str | None = None
    for attempt_no in range(1, MAX_JSON_ATTEMPTS + 1):
        try:
            response = provider.generate_content(prompt=prompt, response_json=True)
        except LLMChainExhaustedError:
            # Every provider is down (Gemini 429, GH Models 410, …).
            # Return a deterministic fallback so the operator still sees
            # a lesson today instead of a hard 404.
            logger.warning("Daily lesson: LLM chain exhausted, using fallback")
            return _fallback_lesson(name, facts)
        except Exception as exc:
            logger.exception("LLM generation failed for daily lesson: %s", exc)
            raise LLMProviderError(f"Daily lesson LLM generation failed: {exc}") from exc

        try:
            data = _parse_lesson_json(response.text)
        except (json.JSONDecodeError, ValueError) as exc:
            last_bad_snippet = (response.text or "")[:200]
            logger.warning(
                "Daily lesson JSON parse failed on attempt %d/%d: %s | snippet=%r",
                attempt_no, MAX_JSON_ATTEMPTS, exc, last_bad_snippet,
            )
            if attempt_no == MAX_JSON_ATTEMPTS:
                raise LLMProviderError(
                    "Daily lesson LLM response is not valid JSON after retry"
                ) from exc
            continue

        return {
            "summary": data.get("summary", ""),
            "highlights": data.get("highlights", []),
            "tips": data.get("tips", []),
            "micro_lesson": (data.get("micro_lesson", "") or "")[:280],
            "model_used": response.model_used or "unknown",
            "provider": response.provider or "unknown",
        }

    # Should be unreachable — loop either returns or raises above.
    raise LLMProviderError("Daily lesson LLM response is not valid JSON after retry")

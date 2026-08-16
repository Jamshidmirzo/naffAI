import json
import logging
from pathlib import Path

from apps.tg_userclient.ai.provider import (
    LLMChainExhaustedError,
    LLMProviderError,
    get_llm_provider,
)

logger = logging.getLogger("apps.lessons.ai")

PROMPTS_DIR = Path(__file__).parent / "prompts"

# One retry on JSON garbage — LLMs are non-deterministic, second time
# they often respond cleanly. Two total attempts (initial + retry).
MAX_JSON_ATTEMPTS = 2

# Bumped from v1 → v2 when the prompt shape switched from
# flat {summary, highlights, tips, micro_lesson} to the new
# {greeting_line, yesterday_summary, main_insight, highlights, blockers,
#  practice_today, micro_lesson, closing_line} structure.
PROMPT_VERSION = "v2"

SUPPORTED_LANGUAGES = ("ru", "uz")
# Phone-shop default is Uzbek — most operators are Uzbek-first, and the
# `_prompt_path_for` helper falls back here when a caller doesn't pass
# `language=` explicitly. Callers with a resolved language (via
# `resolve_operator_language`) still get what they asked for.
DEFAULT_LANGUAGE = "uz"


def _prompt_path_for(language: str) -> Path:
    lang = language if language in SUPPORTED_LANGUAGES else DEFAULT_LANGUAGE
    if lang == "ru":
        return PROMPTS_DIR / "daily_lesson_v1.md"
    # 'uz' is now the default — any unknown language falls back here
    # (see DEFAULT_LANGUAGE note above).
    return PROMPTS_DIR / "daily_lesson_v1_uz.md"


def _fallback_lesson_ru(name: str, facts: dict) -> dict:
    """
    Deterministic RU fallback in v2 shape — used when every LLM provider
    is down (Gemini free-tier exhausted, GH Models retirement brownout,
    etc.). Not as poetic as an LLM write-up but it beats a 404: the
    operator still gets yesterday's numbers + generic action steps in the
    same v2 shape the UI expects.
    """
    sales = facts.get("sales", {})
    dialogs = facts.get("dialogs", {})
    callbacks = facts.get("callbacks", {})
    leads = facts.get("leads", {})

    cnt = int(sales.get("count") or 0)
    rev = int(sales.get("revenue") or 0)
    avg = int(sales.get("avg_check") or 0)
    won = int(leads.get("won") or 0)
    lost = int(leads.get("lost") or 0)
    dlg = int(dialogs.get("count") or 0)
    missed = int(callbacks.get("missed") or 0)
    dr = sales.get("delta_revenue") or 0

    highlights: list[dict] = []
    if cnt:
        highlights.append({
            "title": "Продажи вчера",
            "evidence": f"{cnt} шт., выручка {rev:,} сум (средний чек {avg:,}).",
        })
    if won:
        highlights.append({"title": "Закрытые лиды", "evidence": f"Won: {won}."})
    if dlg:
        highlights.append({"title": "Активность в TG", "evidence": f"{dlg} диалогов."})

    blockers: list[dict] = []
    if missed:
        blockers.append({
            "title": "Пропущенные callback",
            "why": f"Пропущено {missed} — клиенты остались без ответа.",
            "example": "",
        })
    if lost and lost > max(1, won):
        blockers.append({
            "title": "Потерь больше побед",
            "why": f"Won: {won}, lost: {lost} — работай над возражениями.",
            "example": "",
        })

    practice: list[dict] = [
        {
            "step": "Спрашивай бюджет ДО показа модели",
            "when": "Когда клиент говорит «Покажите телефон»",
            "how": 'Скажи: «На какой бюджет вы ориентируетесь? Подберу под вас лучший вариант».',
        },
        {
            "step": "Закрывай продажу в 3 касания",
            "when": "Если клиент задал 2 вопроса и ушёл в паузу",
            "how": 'Скажи: «Готовы забронировать модель за 500 000? Я оформлю сразу».',
        },
    ]
    if missed:
        practice.insert(0, {
            "step": "Прозвони все просроченные callback",
            "when": "Первым делом сегодня",
            "how": 'Скажи: «Здравствуйте, {name} из shop. Обещал перезвонить — вот я. Актуально?»',
        })

    yesterday = (
        f"{cnt} продаж на {rev:,} сум"
        + (f" ({'+' if dr >= 0 else ''}{dr:,} к 30-дневному темпу)" if dr else "")
        + f", {dlg} диалогов, callback пропущено: {missed}."
    )

    return {
        "greeting_line": f"{name}, привет.",
        "yesterday_summary": yesterday,
        "main_insight": {
            "title": "Держи ритм",
            "text": "Стабильные касания дают больше, чем один большой чек. Возвращайся к каждому клиенту.",
        },
        "highlights": highlights,
        "blockers": blockers,
        "practice_today": practice[:3],
        "micro_lesson": "Каждому клиенту — вопрос про бюджет ДО презентации.",
        "closing_line": "Собранный день — уверенные продажи.",
        "model_used": "fallback",
        "provider": "fallback",
    }


def _fallback_lesson_uz(name: str, facts: dict) -> dict:
    """UZ version of the deterministic fallback (same v2 shape)."""
    sales = facts.get("sales", {})
    dialogs = facts.get("dialogs", {})
    callbacks = facts.get("callbacks", {})
    leads = facts.get("leads", {})

    cnt = int(sales.get("count") or 0)
    rev = int(sales.get("revenue") or 0)
    avg = int(sales.get("avg_check") or 0)
    won = int(leads.get("won") or 0)
    lost = int(leads.get("lost") or 0)
    dlg = int(dialogs.get("count") or 0)
    missed = int(callbacks.get("missed") or 0)
    dr = sales.get("delta_revenue") or 0

    highlights: list[dict] = []
    if cnt:
        highlights.append({
            "title": "Kechagi sotuvlar",
            "evidence": f"{cnt} ta, tushum {rev:,} so'm (o'rtacha chek {avg:,}).",
        })
    if won:
        highlights.append({"title": "Yopilgan lidlar", "evidence": f"Won: {won}."})
    if dlg:
        highlights.append({"title": "TG faolligi", "evidence": f"{dlg} dialog."})

    blockers: list[dict] = []
    if missed:
        blockers.append({
            "title": "O'tkazib yuborilgan callback",
            "why": f"{missed} ta o'tkazib yuborildi — mijozlar javobsiz qoldi.",
            "example": "",
        })
    if lost and lost > max(1, won):
        blockers.append({
            "title": "Yutqiziqlar g'alabalardan ko'p",
            "why": f"Won: {won}, lost: {lost} — e'tirozlar ustida ishla.",
            "example": "",
        })

    practice: list[dict] = [
        {
            "step": "Model ko'rsatishdan OLDIN byudjet so'ra",
            "when": "Mijoz «Telefon ko'rsating» deganda",
            "how": 'Ayt: «Qanday byudjetga qaraysiz? Sizga eng yaxshi variantni tanlab beraman».',
        },
        {
            "step": "Sotuvni 3 marta tegib yop",
            "when": "Mijoz 2 savol berib jim tursa",
            "how": 'Ayt: «500 000 ga modelni bron qilaylikmi? Hoziroq rasmiylashtiraman».',
        },
    ]
    if missed:
        practice.insert(0, {
            "step": "Barcha muddati o'tgan callbacklarni qo'ng'iroq qil",
            "when": "Bugun eng birinchi ish sifatida",
            "how": 'Ayt: «Assalomu alaykum, men do\'kondan {name}. Qayta qo\'ng\'iroq qilaman degandim — mana. Qiziqasizmi?»',
        })

    yesterday = (
        f"{cnt} ta sotuv {rev:,} so'mga"
        + (f" ({'+' if dr >= 0 else ''}{dr:,} 30 kunlik sur'atga nisbatan)" if dr else "")
        + f", {dlg} dialog, o'tkazib yuborilgan callback: {missed}."
    )

    return {
        "greeting_line": f"{name}, salom.",
        "yesterday_summary": yesterday,
        "main_insight": {
            "title": "Sur'atni ushlab tur",
            "text": "Barqaror aloqalar bir katta chekdan ko'p beradi. Har bir mijozga qayta chiq.",
        },
        "highlights": highlights,
        "blockers": blockers,
        "practice_today": practice[:3],
        "micro_lesson": "Har mijozga — prezentatsiyadan OLDIN byudjet savoli.",
        "closing_line": "Jamlangan kun — ishonchli sotuvlar.",
        "model_used": "fallback",
        "provider": "fallback",
    }


def _fallback_lesson(name: str, facts: dict, language: str) -> dict:
    v2 = _fallback_lesson_uz(name, facts) if language == "uz" else _fallback_lesson_ru(name, facts)
    # Package into the same `{content, summary, highlights, tips, micro_lesson,
    # model_used, provider}` shape the LLM path returns. Legacy flat fields are
    # derived from the v2 block so old consumers keep rendering.
    content_v2 = {
        "greeting_line": v2["greeting_line"],
        "yesterday_summary": v2["yesterday_summary"],
        "main_insight": v2["main_insight"],
        "highlights": v2["highlights"],
        "blockers": v2["blockers"],
        "practice_today": v2["practice_today"],
        "micro_lesson": v2["micro_lesson"],
        "closing_line": v2["closing_line"],
    }
    legacy_tips = _blockers_to_legacy_tips(content_v2)
    return {
        "content": content_v2,
        "summary": content_v2["yesterday_summary"],
        "highlights": content_v2["highlights"],
        "tips": legacy_tips,
        "micro_lesson": content_v2["micro_lesson"],
        "model_used": v2["model_used"],
        "provider": v2["provider"],
    }


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


def _summary_from_v2(data: dict) -> str:
    """
    Best-effort compact summary for legacy `DailyLesson.summary` field —
    keeps back-compat with anything that still reads that flat column
    (older UI, tests, TG-DM digest). We use `yesterday_summary` as the
    canonical short paragraph.
    """
    s = data.get("yesterday_summary") or ""
    if not isinstance(s, str):
        return ""
    return s.strip()


def _highlights_from_v2(data: dict) -> list:
    hl = data.get("highlights") or []
    return hl if isinstance(hl, list) else []


def _blockers_to_legacy_tips(data: dict) -> list:
    """
    Map new v2 `blockers[]` + `practice_today[]` back into the flat legacy
    `tips[]` shape so any old consumer (bot digest, older frontends) still
    gets sensible content until they migrate to `content`.
    """
    blockers = data.get("blockers") or []
    practice = data.get("practice_today") or []
    if not isinstance(blockers, list):
        blockers = []
    if not isinstance(practice, list):
        practice = []

    tips: list[dict] = []
    for i in range(max(len(blockers), len(practice))):
        b = blockers[i] if i < len(blockers) else {}
        p = practice[i] if i < len(practice) else {}
        title = (b.get("title") if isinstance(b, dict) else "") or (
            p.get("step") if isinstance(p, dict) else ""
        ) or ""
        why = b.get("why") if isinstance(b, dict) else ""
        example = b.get("example") if isinstance(b, dict) else ""
        action_bits = []
        if isinstance(p, dict):
            if p.get("step"):
                action_bits.append(str(p["step"]))
            if p.get("how"):
                action_bits.append(str(p["how"]))
        tips.append({
            "title": str(title),
            "why": str(why or ""),
            "example": str(example or ""),
            "action": " — ".join(action_bits) if action_bits else "",
        })
    return tips


def generate_daily_lesson(
    name: str,
    tenure_days: int,
    facts: dict,
    language: str = DEFAULT_LANGUAGE,
) -> dict:
    """
    Generate daily lesson content using the configured LLM provider.

    ``language`` selects which prompt file to use (``'ru'`` or ``'uz'``).
    Any other value falls back to RU. The response is coerced into the
    v2 shape (``content`` dict) plus a flat back-compat surface
    (``summary`` / ``highlights`` / ``tips`` / ``micro_lesson``) so
    ``DailyLesson`` rows keep working for any consumer that hasn't
    migrated to ``content`` yet.

    Retries once on garbage JSON: LLM responses are non-deterministic and
    the same prompt can produce valid JSON on the second try. Provider-side
    errors (network, quota, etc.) are re-raised as ``LLMProviderError``
    without retry — the outer command handler will record the failure.
    """
    provider = get_llm_provider()

    prompt_path = _prompt_path_for(language)
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
            # Every provider is down. Return a deterministic fallback so
            # the operator still sees a lesson today instead of a hard 404.
            logger.warning("Daily lesson: LLM chain exhausted, using fallback (%s)", language)
            return _fallback_lesson(name, facts, language)
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

        # v2 shape: pull structured content out AND compute the flat legacy
        # fields from it so old consumers keep rendering.
        #
        # If the LLM (or a test fixture) returned the old v1 flat shape
        # only (summary + highlights + tips + micro_lesson), we still
        # accept it and leave `content` empty so callers know it's a
        # legacy row.
        is_v2 = any(
            data.get(k) for k in ("greeting_line", "yesterday_summary", "main_insight", "blockers", "practice_today", "closing_line")
        )

        if is_v2:
            content_v2 = {
                "greeting_line": str(data.get("greeting_line") or ""),
                "yesterday_summary": str(data.get("yesterday_summary") or ""),
                "main_insight": data.get("main_insight") or {},
                "highlights": _highlights_from_v2(data),
                "blockers": data.get("blockers") or [],
                "practice_today": data.get("practice_today") or [],
                "micro_lesson": str(data.get("micro_lesson") or "")[:280],
                "closing_line": str(data.get("closing_line") or ""),
            }
            legacy_tips = _blockers_to_legacy_tips(data)
            summary = _summary_from_v2(data) or str(data.get("summary") or "")
        else:
            content_v2 = {}
            legacy_tips = data.get("tips") if isinstance(data.get("tips"), list) else []
            summary = str(data.get("summary") or "")

        return {
            # v2 canonical block for the new UI (empty dict if legacy)
            "content": content_v2,
            # legacy flat fields (always populated so back-compat renderers work)
            "summary": summary,
            "highlights": _highlights_from_v2(data),
            "tips": legacy_tips,
            "micro_lesson": str(data.get("micro_lesson") or "")[:280],
            # meta
            "model_used": response.model_used or "unknown",
            "provider": response.provider or "unknown",
        }

    # Should be unreachable — loop either returns or raises above.
    raise LLMProviderError("Daily lesson LLM response is not valid JSON after retry")

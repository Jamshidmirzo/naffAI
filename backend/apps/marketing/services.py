"""
Marketing analyst service.

- ``build_dashboard_payload`` collects every marketing selector for the
  period into a single JSON-serialisable dict. Used both by the dashboard
  API and as the LLM input.
- ``generate_marketing_insight`` runs the LLM with the marketer persona
  prompt, validates JSON schema, retries via the provider chain on bad
  output, and upserts a ``MarketingInsight`` row.
"""

from __future__ import annotations

import datetime as dt
import json
import logging
from decimal import Decimal
from typing import Any

from django.db import transaction
from django.db.models import Count, Q, Sum
from django.utils import timezone

from apps.analytics.selectors import (
    channel_source_matrix,
    cohort_conversion,
    funnel_by_source,
    marketing_source_breakdown,
    marketing_totals,
    rejection_reasons_by_source,
    time_pattern_by_source,
    wow_delta,
)
from apps.audit.services import AuditAction, audit_log_create
from apps.leads.models import Lead
from apps.tg_userclient.ai.provider import LLMChainExhaustedError, get_marketing_provider

from .models import AdSpend, MarketingInsight
from .prompts import resolve_prompts

logger = logging.getLogger("apps.marketing")


# ---- Public data-collection helper ------------------------------------


def _to_dt_range(period_start: dt.date, period_end: dt.date) -> tuple[dt.datetime, dt.datetime]:
    tz = timezone.get_current_timezone()
    start_dt = dt.datetime.combine(period_start, dt.time.min, tzinfo=tz)
    end_dt = dt.datetime.combine(period_end, dt.time.max, tzinfo=tz)
    return start_dt, end_dt


def build_dashboard_payload(
    *,
    period_start: dt.date,
    period_end: dt.date,
) -> dict:
    """
    Collect every marketing selector for the period.

    Return shape (all JSON-serialisable):
      {
        "period": {"start", "end", "days"},
        "totals": {...},
        "sources": [...],
        "funnels": [...],
        "time_patterns": {...},
        "rejection_reasons": [...],
        "channels": [...],
        "cohorts": [...],
        "wow": {...},
        "adspend_summary": {"has_data": bool, "total": str}
      }
    """
    start_dt, end_dt = _to_dt_range(period_start, period_end)
    days = (period_end - period_start).days + 1

    totals = marketing_totals(date_from=start_dt, date_to=end_dt)
    sources = marketing_source_breakdown(date_from=start_dt, date_to=end_dt)
    funnels = funnel_by_source(date_from=start_dt, date_to=end_dt)
    time_patterns = time_pattern_by_source(date_from=start_dt, date_to=end_dt)
    rejection = rejection_reasons_by_source(date_from=start_dt, date_to=end_dt)
    channels = channel_source_matrix(date_from=start_dt, date_to=end_dt)
    cohorts = cohort_conversion(weeks_back=max(4, min(12, days // 7 + 2)))
    wow = wow_delta(date_from=start_dt, date_to=end_dt)

    # AdSpend summary.
    spend_total = AdSpend.objects.filter(
        period_start__lte=period_end,
        period_end__gte=period_start,
    ).aggregate(t=Sum("amount"))["t"] or Decimal("0")

    return {
        "period": {
            "start": period_start.isoformat(),
            "end": period_end.isoformat(),
            "days": days,
        },
        "totals": totals,
        "sources": sources,
        "funnels": funnels,
        "time_patterns": time_patterns,
        "rejection_reasons": rejection,
        "channels": channels,
        "cohorts": cohorts,
        "wow": wow,
        "adspend_summary": {
            "has_data": spend_total > 0,
            "total": str(spend_total),
        },
    }


# ---- LLM output validation --------------------------------------------


REQUIRED_TOP_KEYS = {"summary", "highlights", "recommendations"}
RECOMMENDATION_KEYS = {"priority", "action", "source", "evidence"}
VALID_PRIORITIES = {"high", "medium", "low"}
VALID_HIGHLIGHT_TYPES = {"win", "warn", "insight"}


def validate_structured_output(payload: Any) -> tuple[bool, str]:
    """
    Return (ok, error_message). Non-fatal (empty highlights / recs) is OK
    as long as the schema is respected — helps distinguish "LLM is weak"
    from "LLM returned garbage".
    """
    if not isinstance(payload, dict):
        return False, f"top-level not dict: {type(payload).__name__}"
    missing = REQUIRED_TOP_KEYS - set(payload.keys())
    if missing:
        return False, f"missing keys: {sorted(missing)}"
    if not isinstance(payload.get("summary"), str):
        return False, "summary is not str"
    if not isinstance(payload.get("highlights"), list):
        return False, "highlights is not list"
    if not isinstance(payload.get("recommendations"), list):
        return False, "recommendations is not list"
    for i, rec in enumerate(payload["recommendations"]):
        if not isinstance(rec, dict):
            return False, f"rec[{i}] not dict"
        missing_rec = RECOMMENDATION_KEYS - set(rec.keys())
        if missing_rec:
            return False, f"rec[{i}] missing: {sorted(missing_rec)}"
        prio = rec.get("priority")
        if prio not in VALID_PRIORITIES:
            return False, f"rec[{i}] bad priority: {prio!r}"
    for i, hi in enumerate(payload["highlights"]):
        if not isinstance(hi, dict) or "text" not in hi:
            return False, f"highlight[{i}] not {{type,text}}"
    return True, ""


def _parse_llm_json_loose(raw: str) -> Any:
    """Tolerant JSON parse — strips ```json fences before decoding."""
    text = (raw or "").strip()
    if text.startswith("```"):
        lines = [ln for ln in text.split("\n") if not ln.strip().startswith("```")]
        text = "\n".join(lines).strip()
    if not text:
        return None
    # Cut trailing non-JSON tail (some models append "…" after the closing brace).
    end = text.rfind("}")
    if end > 0:
        text = text[: end + 1]
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return None


def _static_fallback(payload: dict) -> dict:
    """
    Data-driven no-LLM fallback: still produces highlights + recs from
    numbers so the FE has something to render.
    """
    sources = payload.get("sources") or []
    totals = payload.get("totals") or {}
    highlights: list[dict] = []
    recommendations: list[dict] = []

    if not sources:
        return {
            "summary": "Нет данных о лидах за период.",
            "highlights": [{"type": "warn", "text": "За период не найдено ни одного лида."}],
            "recommendations": [],
            "questions_for_owner": ["Настроена ли синхронизация Google Sheets? Работает ли Telegram-бот?"],
        }

    best = max(sources, key=lambda s: s.get("conv_rate", 0))
    if best.get("conv_rate", 0) > 0:
        highlights.append({
            "type": "win",
            "text": f"Лидер конверсии — {best['source_name']}: {best['conv_rate']}% ({best['converted']}/{best['leads']} лидов).",
        })
        recommendations.append({
            "priority": "high",
            "action": f"Усилить работу с источником «{best['source_name']}»",
            "source": best["source_name"],
            "evidence": f"Конверсия {best['conv_rate']}% при {best['leads']} лидах — выше средней. Средний чек {best.get('avg_check', '0')} сум.",
            "expected_impact": "Больше лидов той же квоты — +сохранение конверсии",
            "confidence": 0.6,
        })
    worst = min(
        [s for s in sources if s.get("leads", 0) >= 5],
        key=lambda s: s.get("conv_rate", 999),
        default=None,
    )
    if worst and worst.get("conv_rate", 0) < 5:
        highlights.append({
            "type": "warn",
            "text": f"Проблема: {worst['source_name']} — конверсия {worst['conv_rate']}% при {worst['leads']} лидах.",
        })
        recommendations.append({
            "priority": "medium",
            "action": f"Пересмотреть креатив/скрипт для «{worst['source_name']}»",
            "source": worst["source_name"],
            "evidence": f"{worst['leads']} лидов, {worst['converted']} продаж, conv {worst['conv_rate']}%.",
            "expected_impact": "Если поднять до среднего — доп. продажи",
            "confidence": 0.5,
        })

    return {
        "summary": (
            f"Период: {totals.get('leads', 0)} лидов, {totals.get('converted', 0)} продаж "
            f"({totals.get('conv_rate', 0)}%). Выручка {totals.get('revenue', '0')} сум."
        ),
        "highlights": highlights,
        "recommendations": recommendations,
        "questions_for_owner": [] if payload.get("adspend_summary", {}).get("has_data") else [
            "Введите AdSpend по источникам чтобы получить CAC/ROI-рекомендации."
        ],
    }


def _slim_payload_for_llm(payload: dict) -> dict:
    """
    Reduce the dashboard payload down to only the fields the LLM needs.

    The full snapshot has ≥ 8 sections with per-source top_operators lists
    and 24-slot heatmaps. Dumping it verbatim balloons the prompt past the
    model's budget (GLM burns tokens on reasoning too). We keep the same
    keys but truncate the fat lists — the LLM doesn't need 24 per-hour
    dicts to spot a peak.
    """
    def _hours_peak(hours: list[dict], key: str) -> list[dict]:
        # Keep only the top 5 hours by that metric.
        return sorted(hours, key=lambda h: -h.get(key, 0))[:5]

    slim_tp = []
    for src in (payload.get("time_patterns", {}).get("sources") or []):
        slim_tp.append({
            "source_name": src["source_name"],
            "peak_leads_hours": _hours_peak(src["hours"], "leads"),
            "peak_sales_hours": _hours_peak(src["hours"], "sales"),
        })

    slim_sources = []
    for s in (payload.get("sources") or [])[:10]:  # top-10 by volume
        slim = {
            "source_name": s["source_name"],
            "kind": s["kind"],
            "leads": s["leads"],
            "converted": s["converted"],
            "conv_rate": s["conv_rate"],
            "revenue": s["revenue"],
            "avg_check": s["avg_check"],
            "avg_time_to_conv_hours": s.get("avg_time_to_conv_hours"),
            "top_products": s.get("top_products", [])[:3],
            "top_operators": [
                {"name": o["name"], "count": o["count"], "total": o["total"]}
                for o in s.get("top_operators", [])[:3]
            ],
            "prev_period": s["prev_period"],
            "delta_pp": s["delta_pp"],
            "delta_leads": s["delta_leads"],
        }
        if s.get("adspend", {}).get("amount") and s["adspend"]["amount"] != "0":
            slim["adspend"] = s["adspend"]
        slim_sources.append(slim)

    slim_funnels = payload.get("funnels", [])[:8]
    slim_rejection = payload.get("rejection_reasons", [])[:5]
    slim_channels = payload.get("channels", [])[:5]
    slim_cohorts = payload.get("cohorts", [])[-8:]

    return {
        "period": payload.get("period"),
        "totals": payload.get("totals"),
        "sources": slim_sources,
        "funnels": slim_funnels,
        "time_patterns": slim_tp,
        "rejection_reasons": slim_rejection,
        "channels": slim_channels,
        "cohorts": slim_cohorts,
        "wow": payload.get("wow"),
        "adspend_summary": payload.get("adspend_summary"),
    }


def _run_llm(payload: dict, *, language: str = "uz") -> tuple[dict, str, str]:
    """
    Ask the LLM for the marketer-persona structured output.

    Returns (structured_dict, model_version, provider_used). Falls back to
    static analyser on chain exhaustion / invalid JSON. ``language`` picks
    the RU or UZ prompt bundle — phone-shop default is UZ.
    """
    prompts = resolve_prompts(language)
    adspend_hint = (
        prompts["adspend_hint_with_data"]
        if payload.get("adspend_summary", {}).get("has_data")
        else prompts["adspend_hint_empty"]
    )
    slim = _slim_payload_for_llm(payload)
    # Compact JSON — no indent, saves tokens.
    user_text = prompts["user_template"].format(
        period_start=slim["period"]["start"],
        period_end=slim["period"]["end"],
        days=slim["period"]["days"],
        totals_json=json.dumps(slim["totals"], ensure_ascii=False),
        sources_json=json.dumps(slim["sources"], ensure_ascii=False),
        funnels_json=json.dumps(slim["funnels"], ensure_ascii=False),
        time_patterns_json=json.dumps(slim["time_patterns"], ensure_ascii=False),
        rejection_reasons_json=json.dumps(slim["rejection_reasons"], ensure_ascii=False),
        channels_json=json.dumps(slim["channels"], ensure_ascii=False),
        cohorts_json=json.dumps(slim["cohorts"], ensure_ascii=False),
        wow_json=json.dumps(slim["wow"], ensure_ascii=False),
        adspend_hint=adspend_hint,
    )
    combined_prompt = f"{prompts['system']}\n\n{prompts['few_shot']}\n\n---\n\n{user_text}"
    logger.info("marketing LLM prompt size: %d chars", len(combined_prompt))

    try:
        provider = get_marketing_provider()
        # Marketing needs a longer completion budget than the default 2000
        # — the marketer-persona output can easily reach 3-4KB, and reasoning
        # models (GLM) burn extra tokens on the internal reasoning trace.
        resp = provider.generate_content(
            prompt=combined_prompt, response_json=True, max_tokens=8000,
        )
        raw = (getattr(resp, "text", "") or "").strip()
        parsed = _parse_llm_json_loose(raw)
        ok, err = validate_structured_output(parsed)
        if not ok:
            logger.warning(
                "marketing LLM returned invalid schema: %s (raw_len=%d, tail=%r)",
                err, len(raw), raw[-200:] if raw else "",
            )
            structured = _static_fallback(payload)
            return structured, "invalid_json_fallback", getattr(resp, "provider", "") or "fallback"
        # Ensure questions_for_owner exists.
        if "questions_for_owner" not in parsed:
            parsed["questions_for_owner"] = []
        return parsed, getattr(resp, "model_used", "") or "unknown", getattr(resp, "provider", "") or ""
    except LLMChainExhaustedError as exc:
        logger.warning("marketing LLM chain exhausted: %s", exc)
        return _static_fallback(payload), "exhausted", "exhausted"
    except Exception as exc:  # noqa: BLE001
        logger.warning("marketing LLM failed: %s", exc)
        return _static_fallback(payload), "fallback", "fallback"


# ---- Back-compat helpers (populate legacy fields from structured output) -


def _legacy_lead_quality_by_source(sources: list[dict]) -> dict:
    """Old dashboard chart expected this shape — keep populating it."""
    out = {}
    for s in sources:
        name = s.get("source_name") or "—"
        out[name] = {
            "sheet_source_id": s.get("sheet_source_id"),
            "source_name": name,
            "leads": s.get("leads", 0),
            "converted": s.get("converted", 0),
            "conversion_rate": s.get("conv_rate", 0.0),
        }
    return out


def _legacy_top_products(sources: list[dict]) -> list[dict]:
    counts: dict[str, int] = {}
    for s in sources:
        for p in s.get("top_products", []) or []:
            counts[p["name"]] = counts.get(p["name"], 0) + p["count"]
    return [
        {"product": k, "mentions": v}
        for k, v in sorted(counts.items(), key=lambda x: -x[1])[:15]
    ]


def _legacy_recommendations(structured: dict) -> list[str]:
    """Flatten structured recommendations into bullet strings for the old UI."""
    out = []
    for r in structured.get("recommendations", []) or []:
        prio = str(r.get("priority", "")).upper()
        action = r.get("action", "")
        src = r.get("source", "")
        evidence = r.get("evidence", "")
        out.append(f"[{prio}] {action} ({src}) — {evidence}")
    return out


# ---- Main entry point --------------------------------------------------


@transaction.atomic
def generate_marketing_insight(
    *,
    period_start: dt.date,
    period_end: dt.date,
    user=None,
    language: str = "",
) -> MarketingInsight:
    payload = build_dashboard_payload(period_start=period_start, period_end=period_end)
    # Resolve language: explicit arg > requesting user's profile > phone-shop
    # default (uz). Marketing insights are usually generated on-demand by a
    # manager pressing "Refresh" — we key on their preferred_language.
    if not language and user is not None:
        prof = getattr(user, "profile", None)
        language = getattr(prof, "preferred_language", "") if prof else ""
    language = language or "uz"
    structured, model_version, provider_used = _run_llm(payload, language=language)

    insight, created = MarketingInsight.objects.update_or_create(
        period_start=period_start,
        period_end=period_end,
        defaults={
            # New fields
            "structured_output": structured,
            "dashboard_payload_snapshot": payload,
            # Legacy fields (for the old Marketing.tsx to keep rendering)
            "lead_quality_by_source": _legacy_lead_quality_by_source(payload.get("sources") or []),
            "targeting_recommendations": _legacy_recommendations(structured),
            "top_products": _legacy_top_products(payload.get("sources") or []),
            "summary": structured.get("summary", ""),
            "model_version": model_version,
            "provider_used": provider_used,
        },
    )
    audit_log_create(
        user=user,
        action=AuditAction.CREATE if created else AuditAction.UPDATE,
        entity="marketing.MarketingInsight",
        entity_id=insight.id,
        changes={"period_start": period_start.isoformat(), "period_end": period_end.isoformat()},
    )
    return insight


# ---- Recommendation-action tracking -----------------------------------


def mark_recommendation_done(
    *,
    insight_id: int,
    index: int,
    user=None,
) -> MarketingInsight:
    """
    Toggle a recommendation as "done" (or undo if already marked).
    Stores in MarketingInsight.actions_taken as list of {index, done_at, user_id}.
    """
    insight = MarketingInsight.objects.select_for_update().get(pk=insight_id)
    recs = (insight.structured_output or {}).get("recommendations") or []
    if index < 0 or index >= len(recs):
        raise ValueError(f"recommendation index out of range: {index}")

    actions = list(insight.actions_taken or [])
    # Toggle: if already done → remove; else add.
    already = [a for a in actions if a.get("index") == index]
    if already:
        actions = [a for a in actions if a.get("index") != index]
    else:
        actions.append({
            "index": index,
            "done_at": timezone.now().isoformat(),
            "user_id": getattr(user, "id", None),
        })
    insight.actions_taken = actions
    insight.save(update_fields=["actions_taken", "updated_at"])
    audit_log_create(
        user=user,
        action=AuditAction.UPDATE,
        entity="marketing.MarketingInsight",
        entity_id=insight.id,
        changes={"toggled_recommendation": index, "now_done": not already},
    )
    return insight


# ---- AdSpend service helpers ------------------------------------------


@transaction.atomic
def adspend_create(
    *,
    period_start: dt.date,
    period_end: dt.date,
    source_id: int | None,
    source_label: str,
    amount: Decimal,
    note: str = "",
    currency: str = "UZS",
    user=None,
) -> AdSpend:
    if period_end < period_start:
        raise ValueError("period_end < period_start")
    if amount <= 0:
        raise ValueError("amount must be > 0")
    if not source_id and not source_label.strip():
        raise ValueError("either source_id or source_label must be provided")

    row = AdSpend.objects.create(
        period_start=period_start,
        period_end=period_end,
        source_id=source_id,
        source_label=source_label.strip(),
        amount=amount,
        currency=currency,
        note=note,
        created_by=user,
    )
    audit_log_create(
        user=user,
        action=AuditAction.CREATE,
        entity="marketing.AdSpend",
        entity_id=row.id,
        changes={
            "period_start": period_start.isoformat(),
            "period_end": period_end.isoformat(),
            "amount": str(amount),
            "source_id": source_id,
            "source_label": source_label,
        },
    )
    return row


@transaction.atomic
def adspend_update(
    *,
    row_id: int,
    fields: dict,
    user=None,
) -> AdSpend:
    row = AdSpend.objects.select_for_update().get(pk=row_id)
    allowed = {"period_start", "period_end", "source_id", "source_label",
               "amount", "currency", "note"}
    changed: dict[str, Any] = {}
    for k, v in fields.items():
        if k not in allowed:
            continue
        setattr(row, k, v)
        changed[k] = str(v) if v is not None else None
    row.save(update_fields=list(changed.keys()) + ["updated_at"])
    audit_log_create(
        user=user,
        action=AuditAction.UPDATE,
        entity="marketing.AdSpend",
        entity_id=row.id,
        changes=changed,
    )
    return row


@transaction.atomic
def adspend_delete(*, row_id: int, user=None) -> None:
    row = AdSpend.objects.get(pk=row_id)
    audit_log_create(
        user=user,
        action=AuditAction.DELETE,
        entity="marketing.AdSpend",
        entity_id=row.id,
        changes={"amount": str(row.amount), "source_id": row.source_id, "source_label": row.source_label},
    )
    row.delete()

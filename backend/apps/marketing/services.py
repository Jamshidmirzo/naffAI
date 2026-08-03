"""
Marketing analyst service — collects raw stats from selectors, asks the
LLM for recommendations, and upserts a ``MarketingInsight`` for the
period.

Called from the ``run_marketing_analyst`` management command (weekly
cron) or triggered manually from the UI.
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

from apps.audit.services import AuditAction, audit_log_create
from apps.leads.models import Lead
from apps.tg_userclient.ai.provider import LLMChainExhaustedError, get_marketing_provider

from .models import MarketingInsight

logger = logging.getLogger("apps.marketing")

MARKETING_PROMPT_TEMPLATE = """Ты — маркетинг-аналитик для магазина телефонов, работающего через call-центр.

Данные за период {period_start} — {period_end}:

Лиды по источникам (Google Sheets vкладкам):
{sources_json}

Топ моделей телефонов, которые упоминались в лидах:
{products_json}

Задача:
1) Дай 3-5 конкретных рекомендаций по таргетингу (какие источники прибавить, какие сократить, какие модели рекламировать).
2) Одно короткое резюме на 1-2 предложения.

Ответ строго в JSON:
{{
  "recommendations": ["...", "..."],
  "summary": "..."
}}"""


def _collect_source_stats(*, period_start: dt.date, period_end: dt.date) -> list[dict]:
    """Per-sheet volume, conversion (leads → won)."""
    start_dt = dt.datetime.combine(
        period_start, dt.time.min, tzinfo=timezone.get_current_timezone()
    )
    end_dt = dt.datetime.combine(period_end, dt.time.max, tzinfo=timezone.get_current_timezone())
    rows = (
        Lead.objects.filter(
            created_at__gte=start_dt, created_at__lte=end_dt, sheet_source__isnull=False
        )
        .values("sheet_source_id", "sheet_source__name")
        .annotate(
            leads=Count("id"),
            converted=Count("id", filter=Q(status="won")),
        )
        .order_by("-leads")
    )
    result = []
    for r in rows:
        leads = r["leads"] or 0
        converted = r["converted"] or 0
        result.append(
            {
                "sheet_source_id": r["sheet_source_id"],
                "source_name": r["sheet_source__name"] or "",
                "leads": leads,
                "converted": converted,
                "conversion_rate": round(converted * 100.0 / leads, 2) if leads else 0.0,
            }
        )
    return result


def _collect_top_products(*, period_start: dt.date, period_end: dt.date) -> list[dict]:
    start_dt = dt.datetime.combine(
        period_start, dt.time.min, tzinfo=timezone.get_current_timezone()
    )
    end_dt = dt.datetime.combine(period_end, dt.time.max, tzinfo=timezone.get_current_timezone())
    rows = (
        Lead.objects.filter(created_at__gte=start_dt, created_at__lte=end_dt)
        .exclude(product_hint="")
        .values("product_hint")
        .annotate(mentions=Count("id"))
        .order_by("-mentions")[:15]
    )
    return [{"product": r["product_hint"], "mentions": r["mentions"]} for r in rows]


def _default_recommendations(sources: list[dict]) -> list[str]:
    """Static fallback if the LLM is unavailable — still useful data-driven text."""
    if not sources:
        return ["Нет данных о лидах за период — расширьте синхронизацию Google Sheets."]
    best = max(sources, key=lambda s: s["conversion_rate"], default=None)
    worst = min(sources, key=lambda s: s["conversion_rate"], default=None)
    tips: list[str] = []
    if best and best["conversion_rate"] > 0:
        tips.append(
            f"Источник «{best['source_name']}» имеет конверсию {best['conversion_rate']}% — усилить бюджет."
        )
    if worst and worst["conversion_rate"] < 1 and worst.get("leads", 0) > 20:
        tips.append(
            f"«{worst['source_name']}» даёт много лидов ({worst['leads']}), но почти без конверсии — пересмотреть креатив."
        )
    return tips or ["Данных пока недостаточно для конкретных рекомендаций."]


@transaction.atomic
def generate_marketing_insight(
    *,
    period_start: dt.date,
    period_end: dt.date,
    user=None,
) -> MarketingInsight:
    sources = _collect_source_stats(period_start=period_start, period_end=period_end)
    products = _collect_top_products(period_start=period_start, period_end=period_end)

    prompt = MARKETING_PROMPT_TEMPLATE.format(
        period_start=period_start.isoformat(),
        period_end=period_end.isoformat(),
        sources_json=json.dumps(sources, ensure_ascii=False, indent=2, default=str),
        products_json=json.dumps(products, ensure_ascii=False, indent=2),
    )

    recommendations: list[str]
    summary: str
    model_version: str
    provider_used: str

    try:
        provider = get_marketing_provider()
        resp = provider.generate_content(prompt=prompt, response_json=True)
        raw = (resp.text or "").strip()
        # Gemini/OpenAI-style JSON may arrive wrapped in ```json fences.
        if raw.startswith("```"):
            raw = raw.strip("`").lstrip("json").strip()
        parsed: Any = None
        try:
            parsed = json.loads(raw) if raw.startswith("{") else None
        except json.JSONDecodeError:
            parsed = None
        if isinstance(parsed, dict):
            recommendations = list(parsed.get("recommendations", []))
            summary = str(parsed.get("summary", "") or "")
        else:
            recommendations = _default_recommendations(sources)
            summary = raw[:400] or "LLM не вернул структурированный ответ."
        model_version = resp.model_used or "unknown"
        provider_used = resp.provider or ""
    except LLMChainExhaustedError as exc:
        logger.warning("LLM chain exhausted for marketing insight: %s", exc)
        recommendations = _default_recommendations(sources)
        summary = "Отчёт сгенерирован без LLM (все провайдеры недоступны)."
        model_version = "fallback"
        provider_used = "exhausted"
    except Exception as exc:
        logger.warning("LLM failed for marketing insight: %s", exc)
        recommendations = _default_recommendations(sources)
        summary = "Отчёт сгенерирован без LLM (fallback)."
        model_version = "fallback"
        provider_used = "fallback"

    insight, created = MarketingInsight.objects.update_or_create(
        period_start=period_start,
        period_end=period_end,
        defaults={
            "lead_quality_by_source": {s["source_name"]: s for s in sources},
            "targeting_recommendations": recommendations,
            "top_products": products,
            "summary": summary,
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

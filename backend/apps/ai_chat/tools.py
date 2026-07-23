"""
Read-only AI-chat tools.

Every tool wraps existing selectors and returns a plain-JSON dict. None of
them mutate state — this is a hard product requirement (user asked for a
read-only assistant).

Each tool declares:
- ``description``   Human-friendly explanation used in the LLM prompt.
- ``parameters``    JSON-schema-shaped dict describing accepted args.
- ``handler``       Callable that takes kwargs and returns a JSON dict.
"""

from __future__ import annotations

import datetime as dt
from typing import Any, Callable

from django.utils import timezone

from apps.analytics.selectors import (
    by_channel,
    by_model,
    callback_hour_heatmap,
    kpi_snapshot,
    leaderboard,
    leads_distribution_by_operator,
    operator_funnels,
    resolve_period,
)


def _resolve_window(period: str | None) -> tuple[dt.datetime | None, dt.datetime | None]:
    if period in {"day", "week", "month"}:
        return resolve_period(period)
    return None, None


def get_kpi_snapshot(period: str = "month") -> dict[str, Any]:
    return kpi_snapshot(period=period)


def get_leads_count(status: str | None = None) -> dict[str, Any]:
    from apps.leads.models import Lead

    qs = Lead.objects.all()
    if status:
        qs = qs.filter(status=status)
    return {"count": qs.count(), "status_filter": status or "any"}


def get_sales_summary(period: str = "month") -> dict[str, Any]:
    """Grand totals for the given period + sales count."""
    kpi = kpi_snapshot(period=period)
    block = kpi.get(period) if period in {"today", "week", "month"} else kpi["selected"]
    return {"period": period, "total": block["total"], "count": block["count"]}


def get_operator_stats(operator_id: int | None = None, period: str = "month") -> dict[str, Any]:
    """Return leaderboard row(s) for the given operator (or all)."""
    date_from, date_to = _resolve_window(period)
    lb = leaderboard(date_from=date_from, date_to=date_to, limit=100)
    if operator_id is not None:
        row = next((r for r in lb if r["operator_id"] == operator_id), None)
        return {"operator": row}
    return {"leaderboard": lb, "period": period}


def get_funnel_data(top_n: int = 10) -> dict[str, Any]:
    return {"funnels": operator_funnels(top_n=top_n)}


def get_callback_backlog() -> dict[str, Any]:
    """Pending + overdue callbacks per operator."""
    from django.db.models import Count

    from apps.calls.models import CallbackReminder

    now = timezone.now()
    pending = list(
        CallbackReminder.objects.filter(status="pending")
        .values("operator_id", "operator__full_name")
        .annotate(n=Count("id"))
        .order_by("-n")
    )
    overdue = list(
        CallbackReminder.objects.filter(status="pending", remind_at__lt=now)
        .values("operator_id", "operator__full_name")
        .annotate(n=Count("id"))
        .order_by("-n")
    )
    return {
        "pending": [
            {"operator_id": r["operator_id"], "operator_name": r["operator__full_name"], "count": r["n"]}
            for r in pending
        ],
        "overdue": [
            {"operator_id": r["operator_id"], "operator_name": r["operator__full_name"], "count": r["n"]}
            for r in overdue
        ],
    }


def get_lead_source_quality(period: str = "month") -> dict[str, Any]:
    """Per-sheet lead-source volume and conversion rate for the given window."""
    from django.db.models import Count, Q

    from apps.leads.models import Lead

    date_from, _ = _resolve_window(period)
    qs = Lead.objects.filter(sheet_source__isnull=False)
    if date_from:
        qs = qs.filter(created_at__gte=date_from)

    rows = (
        qs.values("sheet_source_id", "sheet_source__name")
        .annotate(
            leads=Count("id"),
            converted=Count("id", filter=Q(status="won")),
        )
        .order_by("-leads")
    )
    return {
        "period": period,
        "sources": [
            {
                "sheet_source_id": r["sheet_source_id"],
                "source_name": r["sheet_source__name"],
                "leads": r["leads"],
                "converted": r["converted"],
                "conversion_rate": round(r["converted"] * 100.0 / r["leads"], 2) if r["leads"] else 0,
            }
            for r in rows
        ],
    }


def get_channel_and_models(period: str = "month") -> dict[str, Any]:
    date_from, date_to = _resolve_window(period)
    return {
        "channels": by_channel(date_from=date_from, date_to=date_to),
        "top_models": by_model(date_from=date_from, date_to=date_to, limit=10),
    }


def get_leads_distribution() -> dict[str, Any]:
    return {"distribution": leads_distribution_by_operator()}


def get_callback_hour_heatmap(days_back: int = 30) -> dict[str, Any]:
    return callback_hour_heatmap(days_back=days_back)


ToolSpec = dict[str, Any]

TOOLS: dict[str, ToolSpec] = {
    "get_kpi_snapshot": {
        "description": "Return dashboard KPI snapshot (today/week/month totals, active operators).",
        "parameters": {
            "type": "object",
            "properties": {
                "period": {"type": "string", "enum": ["day", "week", "month"]},
            },
        },
        "handler": get_kpi_snapshot,
    },
    "get_leads_count": {
        "description": "Return the number of leads, optionally filtered by status.",
        "parameters": {
            "type": "object",
            "properties": {
                "status": {"type": "string", "description": "Lead status filter, e.g. 'new'."},
            },
        },
        "handler": get_leads_count,
    },
    "get_sales_summary": {
        "description": "Sales total + count for the given period.",
        "parameters": {
            "type": "object",
            "properties": {
                "period": {"type": "string", "enum": ["day", "week", "month"]},
            },
        },
        "handler": get_sales_summary,
    },
    "get_operator_stats": {
        "description": (
            "Return leaderboard rows. If operator_id is given returns just that one operator; "
            "otherwise returns the whole leaderboard."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "operator_id": {"type": "integer"},
                "period": {"type": "string", "enum": ["day", "week", "month"]},
            },
        },
        "handler": get_operator_stats,
    },
    "get_funnel_data": {
        "description": "Per-operator funnel (leads → contacted → callbacks → sales) for the top N operators.",
        "parameters": {
            "type": "object",
            "properties": {"top_n": {"type": "integer"}},
        },
        "handler": get_funnel_data,
    },
    "get_callback_backlog": {
        "description": "Return pending and overdue callback counts per operator.",
        "parameters": {"type": "object", "properties": {}},
        "handler": get_callback_backlog,
    },
    "get_lead_source_quality": {
        "description": "Per-source lead volume and conversion rate for the given period.",
        "parameters": {
            "type": "object",
            "properties": {
                "period": {"type": "string", "enum": ["day", "week", "month"]},
            },
        },
        "handler": get_lead_source_quality,
    },
    "get_channel_and_models": {
        "description": "Sales breakdown by partner-channel and top phone models.",
        "parameters": {
            "type": "object",
            "properties": {
                "period": {"type": "string", "enum": ["day", "week", "month"]},
            },
        },
        "handler": get_channel_and_models,
    },
    "get_leads_distribution": {
        "description": "Active-leads distribution across operators grouped by pipeline bucket.",
        "parameters": {"type": "object", "properties": {}},
        "handler": get_leads_distribution,
    },
    "get_callback_hour_heatmap": {
        "description": "Hour-of-day heatmap of callback reminders per operator (last N days).",
        "parameters": {
            "type": "object",
            "properties": {"days_back": {"type": "integer"}},
        },
        "handler": get_callback_hour_heatmap,
    },
}


def call_tool(name: str, **kwargs: Any) -> dict[str, Any]:
    if name not in TOOLS:
        raise KeyError(f"Unknown tool: {name}")
    handler: Callable = TOOLS[name]["handler"]
    return handler(**kwargs)


__all__ = ["TOOLS", "call_tool"]

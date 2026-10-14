"""
Pure-read KPI pullers for the ROP agent.

HackSoft rule: ORM queries live only here. Services never write SQL and
management commands never touch the ORM — they call selectors instead.

All functions return primitives (int / float / dict / list[dict]) that are
JSON-serialisable so they can be stored on ``DailyBriefing.kpi_snapshot``
and shipped to the LLM payload as-is.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from decimal import Decimal
from typing import Any
from zoneinfo import ZoneInfo

from django.db.models import Count, Q, Sum
from django.utils import timezone

from apps.calls.models import CallAttempt, CallbackReminder, CallbackReminderStatus, CallOutcome
from apps.leads.models import Lead, LeadStatus
from apps.operators.models import Operator, OperatorStatus
from apps.sales.models import Sale, SalePartner, SaleStatus

TZ = ZoneInfo("Asia/Tashkent")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _as_float(x: Any) -> float:
    if x is None:
        return 0.0
    if isinstance(x, Decimal):
        return float(x)
    return float(x)


def day_bounds(d: date) -> tuple[datetime, datetime]:
    """Tashkent-local [start, end) datetimes for the given date."""
    start = datetime.combine(d, time.min, tzinfo=TZ)
    end = start + timedelta(days=1)
    return start, end


def today_tz() -> date:
    return timezone.now().astimezone(TZ).date()


def yesterday_tz() -> date:
    return today_tz() - timedelta(days=1)


# ---------------------------------------------------------------------------
# 1-5: team-wide KPI
# ---------------------------------------------------------------------------
def leads_created(start: datetime, end: datetime) -> int:
    return Lead.objects.filter(created_at__gte=start, created_at__lt=end).count()


def leads_contacted(start: datetime, end: datetime) -> int:
    """Leads with at least one CallAttempt in the window (dedup by lead_id)."""
    return (
        CallAttempt.objects.filter(created_at__gte=start, created_at__lt=end)
        .values("lead_id")
        .distinct()
        .count()
    )


def sales_aggregate(start: datetime, end: datetime) -> dict[str, Any]:
    """Confirmed-only aggregate (pending/rejected excluded)."""
    qs = Sale.objects.filter(
        sold_at__gte=start,
        sold_at__lt=end,
        status=SaleStatus.CONFIRMED,
        is_deleted=False,
    )
    agg = qs.aggregate(count=Count("id"), amount_sum=Sum("amount"))
    cnt = agg["count"] or 0
    total = _as_float(agg["amount_sum"])
    return {
        "count": cnt,
        "amount_sum": total,
        "amount_avg": (total / cnt) if cnt else 0.0,
    }


def conversion_rate(start: datetime, end: datetime) -> float:
    """
    sales / leads_contacted in the window. Returns 0.0 if no contacted leads.
    Range is [0.0, 1.0] (not percent).
    """
    contacted = leads_contacted(start, end)
    if contacted == 0:
        return 0.0
    sales_count = Sale.objects.filter(
        sold_at__gte=start,
        sold_at__lt=end,
        status=SaleStatus.CONFIRMED,
        is_deleted=False,
    ).count()
    return sales_count / contacted


def partner_split(start: datetime, end: datetime) -> list[dict[str, Any]]:
    """Payment-channel share. 'partner' here = Alif/Anor/TBC/Birzum/Hamroh."""
    rows = (
        SalePartner.objects.filter(
            sale__sold_at__gte=start,
            sale__sold_at__lt=end,
            sale__status=SaleStatus.CONFIRMED,
            sale__is_deleted=False,
        )
        .values("partner__name")
        .annotate(count=Count("id"), amount=Sum("amount"))
        .order_by("-amount")
    )
    total = sum(_as_float(r["amount"]) for r in rows) or 0.0
    out: list[dict[str, Any]] = []
    for r in rows:
        amt = _as_float(r["amount"])
        out.append(
            {
                "channel": r["partner__name"] or "—",
                "count": r["count"],
                "amount": amt,
                "pct": (amt / total * 100.0) if total else 0.0,
            }
        )
    return out


# ---------------------------------------------------------------------------
# 6-10: operational signals (qimmatli, followup, operator-level)
# ---------------------------------------------------------------------------
def qimmatli_waiting_now(min_wait_minutes: int = 0) -> list[dict[str, Any]]:
    """
    Qimmatli (hot) leads still waiting:
    - ``hot_until`` is set and NOT yet expired (SLA still active, but worth watching), OR
    - ``hot_until`` expired AND status still NEW/ASSIGNED (SLA breached).
    """
    now = timezone.now()
    cutoff = now - timedelta(minutes=min_wait_minutes)
    qs = Lead.objects.filter(
        hot_until__isnull=False,
        status__in=[LeadStatus.NEW, LeadStatus.ASSIGNED],
        created_at__lte=cutoff,
    ).select_related("operator").order_by("created_at")[:50]
    out = []
    for lead in qs:
        wait = (now - lead.created_at).total_seconds() / 60.0
        out.append(
            {
                "lead_id": lead.id,
                "full_name": (lead.full_name or "").strip() or "—",
                "phone": lead.phone,
                "operator_id": lead.operator_id,
                "operator_name": lead.operator.full_name if lead.operator else None,
                "wait_minutes": int(wait),
                "hot_until": lead.hot_until.isoformat() if lead.hot_until else None,
                "sla_breached": bool(lead.hot_until and lead.hot_until < now),
            }
        )
    return out


def followup_rate_today() -> dict[str, Any]:
    """CallbackReminder done / total for reminders due today (Tashkent)."""
    today = today_tz()
    start, end = day_bounds(today)
    base = CallbackReminder.objects.filter(
        remind_at__gte=start, remind_at__lt=end
    )
    total = base.count()
    done = base.filter(status=CallbackReminderStatus.DONE).count()
    overdue = base.filter(status=CallbackReminderStatus.OVERDUE).count()
    rate = (done / total) if total else 0.0
    return {"total": total, "done": done, "overdue": overdue, "rate": rate}


def per_operator_conv_7d() -> list[dict[str, Any]]:
    """Per-operator conversion for the last 7 full days vs the 7 days before that."""
    today = today_tz()
    this_start, _ = day_bounds(today - timedelta(days=7))
    this_end, _ = day_bounds(today)
    prev_start, _ = day_bounds(today - timedelta(days=14))
    prev_end = this_start

    operators = Operator.objects.filter(status=OperatorStatus.ACTIVE).only("id", "full_name")
    rows: list[dict[str, Any]] = []
    for op in operators:
        this_contacted = (
            CallAttempt.objects.filter(
                operator_id=op.id, created_at__gte=this_start, created_at__lt=this_end
            )
            .values("lead_id")
            .distinct()
            .count()
        )
        this_sales = Sale.objects.filter(
            operator_id=op.id,
            sold_at__gte=this_start,
            sold_at__lt=this_end,
            status=SaleStatus.CONFIRMED,
            is_deleted=False,
        ).count()
        prev_contacted = (
            CallAttempt.objects.filter(
                operator_id=op.id, created_at__gte=prev_start, created_at__lt=prev_end
            )
            .values("lead_id")
            .distinct()
            .count()
        )
        prev_sales = Sale.objects.filter(
            operator_id=op.id,
            sold_at__gte=prev_start,
            sold_at__lt=prev_end,
            status=SaleStatus.CONFIRMED,
            is_deleted=False,
        ).count()
        this_conv = (this_sales / this_contacted) if this_contacted else 0.0
        prev_conv = (prev_sales / prev_contacted) if prev_contacted else 0.0
        rows.append(
            {
                "operator_id": op.id,
                "operator_name": op.full_name,
                "this_contacted": this_contacted,
                "this_sales": this_sales,
                "this_conv": this_conv,
                "prev_conv": prev_conv,
                "delta_pp": (this_conv - prev_conv) * 100.0,
            }
        )
    return rows


def operator_calls_today(operator_id: int) -> int:
    today = today_tz()
    start, end = day_bounds(today)
    return CallAttempt.objects.filter(
        operator_id=operator_id, created_at__gte=start, created_at__lt=end
    ).count()


def silent_operators_now(after_hour: int = 11) -> list[dict[str, Any]]:
    """
    Active operators who placed zero CallAttempts today after `after_hour`
    (Tashkent). Used by ``operator_silent`` RED alert.
    """
    now_tz = timezone.now().astimezone(TZ)
    if now_tz.hour < after_hour:
        return []
    today = now_tz.date()
    start, _ = day_bounds(today)
    end = now_tz
    operators = Operator.objects.filter(status=OperatorStatus.ACTIVE).only("id", "full_name")
    out: list[dict[str, Any]] = []
    for op in operators:
        if CallAttempt.objects.filter(
            operator_id=op.id, created_at__gte=start, created_at__lt=end
        ).exists():
            continue
        out.append({"operator_id": op.id, "operator_name": op.full_name})
    return out


# ---------------------------------------------------------------------------
# KPI snapshot bundle (for briefings)
# ---------------------------------------------------------------------------
@dataclass
class WindowKPI:
    start: datetime
    end: datetime
    label: str
    leads_created: int
    leads_contacted: int
    sales_count: int
    sales_amount: float
    sales_avg: float
    conv: float
    partner_split: list[dict[str, Any]]


def window_kpi(start: datetime, end: datetime, *, label: str) -> dict[str, Any]:
    sa = sales_aggregate(start, end)
    return {
        "start": start.isoformat(),
        "end": end.isoformat(),
        "label": label,
        "leads_created": leads_created(start, end),
        "leads_contacted": leads_contacted(start, end),
        "sales_count": sa["count"],
        "sales_amount": sa["amount_sum"],
        "sales_avg": sa["amount_avg"],
        "conv": conversion_rate(start, end),
        "partner_split": partner_split(start, end),
    }


def morning_kpi_snapshot() -> dict[str, Any]:
    """
    Snapshot used by the 07:00 briefing: yesterday vs the same weekday last week.
    Also includes 7-day rolling averages so the LLM can comment on trend.
    """
    today = today_tz()
    yd = today - timedelta(days=1)
    y_start, y_end = day_bounds(yd)
    week_start, _ = day_bounds(today - timedelta(days=7))
    _, week_end = day_bounds(yd)
    return {
        "today_tashkent": today.isoformat(),
        "yesterday": window_kpi(y_start, y_end, label="kecha"),
        "last_7_days": window_kpi(week_start, week_end, label="oxirgi 7 kun"),
        "per_operator_conv_7d": per_operator_conv_7d(),
        "qimmatli_waiting": qimmatli_waiting_now(min_wait_minutes=30),
        "followup_today": followup_rate_today(),
    }


def midday_kpi_snapshot() -> dict[str, Any]:
    """From 00:00 Tashkent until now."""
    today = today_tz()
    start, _ = day_bounds(today)
    now = timezone.now()
    return {
        "today_tashkent": today.isoformat(),
        "range": window_kpi(start, now, label="bugun hozirgacha"),
        "qimmatli_waiting": qimmatli_waiting_now(min_wait_minutes=15),
        "followup_today": followup_rate_today(),
        "silent_operators": silent_operators_now(),
    }


def evening_kpi_snapshot() -> dict[str, Any]:
    """Full day Tashkent."""
    today = today_tz()
    start, end = day_bounds(today)
    return {
        "today_tashkent": today.isoformat(),
        "today": window_kpi(start, end, label="bugun"),
        "per_operator_conv_7d": per_operator_conv_7d(),
        "followup_today": followup_rate_today(),
    }


def weekly_kpi_snapshot() -> dict[str, Any]:
    today = today_tz()
    this_start, _ = day_bounds(today - timedelta(days=7))
    _, this_end = day_bounds(today - timedelta(days=1))
    prev_start, _ = day_bounds(today - timedelta(days=14))
    prev_end = this_start
    return {
        "today_tashkent": today.isoformat(),
        "this_week": window_kpi(this_start, this_end, label="shu hafta"),
        "prev_week": window_kpi(prev_start, prev_end, label="oldingi hafta"),
        "per_operator_conv_7d": per_operator_conv_7d(),
    }


# ---------------------------------------------------------------------------
# Signals used by alert triggers
# ---------------------------------------------------------------------------
def leads_waiting_over(minutes: int = 30) -> int:
    """New/assigned leads older than `minutes`, no CallAttempt yet."""
    now = timezone.now()
    cutoff = now - timedelta(minutes=minutes)
    return (
        Lead.objects.filter(
            status__in=[LeadStatus.NEW, LeadStatus.ASSIGNED],
            created_at__lte=cutoff,
        )
        .exclude(id__in=CallAttempt.objects.values("lead_id"))
        .count()
    )


def missed_qimmatli_calls_recent(window_minutes: int = 30) -> list[dict[str, Any]]:
    """CallAttempt no_answer within window on a lead whose hot_until is set."""
    now = timezone.now()
    since = now - timedelta(minutes=window_minutes)
    rows = (
        CallAttempt.objects.filter(
            outcome=CallOutcome.NO_ANSWER,
            created_at__gte=since,
            lead__hot_until__isnull=False,
        )
        .select_related("lead", "operator")
        .order_by("-created_at")[:30]
    )
    out = []
    for c in rows:
        out.append(
            {
                "call_id": c.id,
                "lead_id": c.lead_id,
                "lead_name": (c.lead.full_name or "").strip() or "—",
                "operator_id": c.operator_id,
                "operator_name": c.operator.full_name if c.operator else None,
                "at": c.created_at.isoformat(),
            }
        )
    return out


def big_sales_recent(min_amount: int = 15_000_000, window_minutes: int = 60) -> list[dict[str, Any]]:
    """Celebrate confirmed sales >= min_amount in the last window_minutes."""
    since = timezone.now() - timedelta(minutes=window_minutes)
    rows = (
        Sale.objects.filter(
            amount__gte=min_amount,
            status=SaleStatus.CONFIRMED,
            is_deleted=False,
            sold_at__gte=since,
        )
        .select_related("operator")
        .order_by("-sold_at")[:20]
    )
    return [
        {
            "sale_id": s.id,
            "amount": _as_float(s.amount),
            "operator_id": s.operator_id,
            "operator_name": s.operator.full_name if s.operator else None,
            "phone_model": s.phone_model,
            "sold_at": s.sold_at.isoformat(),
        }
        for s in rows
    ]


def overdue_reminders_count_today() -> int:
    today = today_tz()
    start, end = day_bounds(today)
    return CallbackReminder.objects.filter(
        remind_at__gte=start,
        remind_at__lt=end,
        status=CallbackReminderStatus.OVERDUE,
    ).count()


def partner_share_7d_vs_prev() -> list[dict[str, Any]]:
    """7-day channel share vs the previous 7 — used by partner_share_shift alert."""
    today = today_tz()
    this_start, _ = day_bounds(today - timedelta(days=7))
    _, this_end = day_bounds(today - timedelta(days=1))
    prev_start, _ = day_bounds(today - timedelta(days=14))
    prev_end = this_start

    def _shares(start: datetime, end: datetime) -> dict[str, float]:
        rows = (
            SalePartner.objects.filter(
                sale__sold_at__gte=start,
                sale__sold_at__lt=end,
                sale__status=SaleStatus.CONFIRMED,
                sale__is_deleted=False,
            )
            .values("partner__name")
            .annotate(amount=Sum("amount"))
        )
        total = sum(_as_float(r["amount"]) for r in rows) or 0.0
        return {
            (r["partner__name"] or "—"): (_as_float(r["amount"]) / total * 100.0) if total else 0.0
            for r in rows
        }

    this_shares = _shares(this_start, this_end)
    prev_shares = _shares(prev_start, prev_end)
    channels = set(this_shares) | set(prev_shares)
    out: list[dict[str, Any]] = []
    for ch in channels:
        tv = this_shares.get(ch, 0.0)
        pv = prev_shares.get(ch, 0.0)
        out.append({"channel": ch, "this_pct": tv, "prev_pct": pv, "delta_pp": tv - pv})
    out.sort(key=lambda x: abs(x["delta_pp"]), reverse=True)
    return out

from __future__ import annotations

import datetime as dt
from decimal import Decimal

from django.db import models
from django.db.models import Avg, Count, F, Sum, Value
from django.db.models.functions import TruncDate
from django.utils import timezone

from apps.operators.models import Operator, OperatorStatus
from apps.sales.models import Sale, SaleOperator, SalePartner

# All analytics on the Sale side report NET revenue: gross amount minus
# the per-sale discount. Operator-line aggregations (SaleOperator) are
# already net by construction — see `_apply_discount_to_operator_lines`
# in apps.sales.services — so they keep using Sum("amount").
NET_AMOUNT = F("amount") - F("discount")


# ---- period helpers ---------------------------------------------------

VALID_PERIODS = ("day", "week", "month")


def resolve_period(period: str | None) -> tuple[dt.datetime, dt.datetime] | tuple[None, None]:
    """
    Convert `day|week|month` label into a `[start, end]` datetime window
    anchored on now() in the current timezone. Returns (None, None) if
    `period` is missing or unknown — caller must supply explicit dates.

    - day   → current day 00:00 … now
    - week  → current ISO week (Monday 00:00 … now)
    - month → 1st of current month 00:00 … now
    """
    if period not in VALID_PERIODS:
        return None, None
    now = timezone.now()
    start_of_day = now.replace(hour=0, minute=0, second=0, microsecond=0)
    if period == "day":
        return start_of_day, now
    if period == "week":
        start_of_week = start_of_day - dt.timedelta(days=now.weekday())
        return start_of_week, now
    # month
    start_of_month = start_of_day.replace(day=1)
    return start_of_month, now


def _base_qs(date_from: dt.datetime | None = None, date_to: dt.datetime | None = None):
    qs = Sale.objects.filter(is_deleted=False, is_returned=False, status="confirmed")
    if date_from:
        qs = qs.filter(sold_at__gte=date_from)
    if date_to:
        qs = qs.filter(sold_at__lte=date_to)
    return qs


def _line_qs(
    model,
    *,
    date_from: dt.datetime | None = None,
    date_to: dt.datetime | None = None,
):
    """SaleOperator / SalePartner queryset gated to confirmed, non-deleted, non-returned sales."""
    qs = model.objects.filter(
        sale__is_deleted=False, sale__is_returned=False, sale__status="confirmed"
    )
    if date_from:
        qs = qs.filter(sale__sold_at__gte=date_from)
    if date_to:
        qs = qs.filter(sale__sold_at__lte=date_to)
    return qs


def kpi_snapshot(
    period: str | None = None,
    *,
    date_from: dt.datetime | None = None,
    date_to: dt.datetime | None = None,
) -> dict:
    """
    Returns:
      - today / week / month blocks (always, for the header KPI cards)
      - operators_active / operators_trainee counts
      - selected — aggregate for the caller-selected window (either the
        `period` label above, or the explicit `[date_from, date_to]` range
        when both are supplied). The dashboard's «Выбранный период» card
        reads from here so the UI can title arbitrary month picks like
        «Июнь 2026» without inventing period labels.
      - top_of_period — top-1 operator for the selected window (mirrors
        `selected`). Legacy alias `top_of_month` kept for back-compat.

    When both `date_from` and `date_to` are supplied, they override
    `period` for the "selected"/"top" slice. The today/week/month header
    aggregates are always anchored on now() — they are the fixed KPI row.
    """
    now = timezone.now()
    start_of_day = now.replace(hour=0, minute=0, second=0, microsecond=0)
    start_of_week = start_of_day - dt.timedelta(days=now.weekday())
    start_of_month = start_of_day.replace(day=1)

    def agg(*, d_from=None, d_to=None):
        a = _base_qs(date_from=d_from, date_to=d_to).aggregate(
            total=Sum(NET_AMOUNT), count=Count("id")
        )
        return {"total": str(a["total"] or Decimal("0")), "count": a["count"] or 0}

    operators_active = Operator.objects.filter(status=OperatorStatus.ACTIVE).count()
    operators_trainee = Operator.objects.filter(status=OperatorStatus.TRAINEE).count()

    # Selected window: explicit range wins over period label.
    if date_from is not None or date_to is not None:
        sel_from, sel_to = date_from, date_to
        effective_period = "custom"
    else:
        effective_period = period if period in VALID_PERIODS else "month"
        sel_from, sel_to = resolve_period(effective_period)

    selected = agg(d_from=sel_from, d_to=sel_to)

    top_qs = _line_qs(SaleOperator, date_from=sel_from, date_to=sel_to)
    top = (
        top_qs.values("operator_id", "operator__full_name")
        .annotate(total=Sum("amount"), count=Count("sale", distinct=True))
        .order_by("-total")
        .first()
    )
    top_payload = (
        {
            "operator_id": top["operator_id"],
            "operator_name": top["operator__full_name"],
            "total": str(top["total"]),
            "count": top["count"],
        }
        if top
        else None
    )

    return {
        "today": agg(d_from=start_of_day),
        "week": agg(d_from=start_of_week),
        "month": agg(d_from=start_of_month),
        "operators_active": operators_active,
        "operators_trainee": operators_trainee,
        "period": effective_period,
        "selected": selected,
        "top_of_period": top_payload,
        # legacy alias so any existing consumer keeps working
        "top_of_month": top_payload if effective_period == "month" else None,
    }


def leaderboard(
    *,
    date_from: dt.datetime | None = None,
    date_to: dt.datetime | None = None,
    limit: int | None = 20,
) -> list[dict]:
    """Per-operator credit aggregated from SaleOperator lines (multi-op aware).

    Pass ``limit=None`` (or ``0``) to return every operator with sales in the
    window — used by the big-screen dashboard which shows the full ranking.
    """
    qs = (
        _line_qs(SaleOperator, date_from=date_from, date_to=date_to)
        .values("operator_id", "operator__full_name", "operator__status")
        .annotate(total=Sum("amount"), count=Count("sale", distinct=True), avg_ticket=Avg("amount"))
        .order_by("-total")
    )
    rows = qs if not limit else qs[:limit]
    return [
        {
            "operator_id": r["operator_id"],
            "operator_name": r["operator__full_name"],
            "is_trainee": r["operator__status"] == OperatorStatus.TRAINEE,
            "total": str(r["total"] or 0),
            "count": r["count"],
            "avg_ticket": str(r["avg_ticket"] or 0),
        }
        for r in rows
    ]


def by_channel(*, date_from=None, date_to=None) -> list[dict]:
    """Per-partner totals aggregated from SalePartner lines (multi-partner aware)."""
    rows = (
        _line_qs(SalePartner, date_from=date_from, date_to=date_to)
        .values("partner_id", "partner__name")
        .annotate(total=Sum("amount"), count=Count("sale", distinct=True))
        .order_by("-total")
    )
    return [
        {
            "channel_id": r["partner_id"],
            "channel_name": r["partner__name"],
            "total": str(r["total"] or 0),
            "count": r["count"],
        }
        for r in rows
    ]


def by_model(*, date_from=None, date_to=None, limit: int = 20) -> list[dict]:
    qs = _base_qs(date_from=date_from, date_to=date_to)
    rows = (
        qs.values("phone_model")
        .annotate(total=Sum(NET_AMOUNT), count=Count("id"))
        .order_by("-count")[:limit]
    )
    return [
        {"phone_model": r["phone_model"], "total": str(r["total"] or 0), "count": r["count"]}
        for r in rows
    ]


def sales_by_source(
    *,
    date_from: dt.datetime | None = None,
    date_to: dt.datetime | None = None,
) -> list[dict]:
    """
    Aggregate confirmed sales by the sheet source they came from. Sales
    without a `sheet_source` (direct sales) are grouped under "Прямая".

    Also counts total leads that flowed through each source in the window
    so the UI can show a per-source conversion rate.
    """
    from apps.leads.models import Lead

    sales_rows = (
        _base_qs(date_from=date_from, date_to=date_to)
        .values("sheet_source_id", "sheet_source__name")
        .annotate(total=Sum(NET_AMOUNT), sales_count=Count("id"))
    )
    sales_by_src: dict[int | None, dict] = {}
    for r in sales_rows:
        sales_by_src[r["sheet_source_id"]] = {
            "sheet_source_id": r["sheet_source_id"],
            "sheet_source_name": r["sheet_source__name"] or "Прямая",
            "total": str(r["total"] or 0),
            "sales_count": r["sales_count"],
        }

    leads_qs = Lead.objects.filter(source="sheet")
    if date_from:
        leads_qs = leads_qs.filter(created_at__gte=date_from)
    if date_to:
        leads_qs = leads_qs.filter(created_at__lte=date_to)
    leads_rows = (
        leads_qs.values("sheet_source_id", "sheet_source__name")
        .annotate(leads_count=Count("id"))
    )
    for r in leads_rows:
        sid = r["sheet_source_id"]
        entry = sales_by_src.setdefault(
            sid,
            {
                "sheet_source_id": sid,
                "sheet_source_name": r["sheet_source__name"] or "Прямая",
                "total": "0",
                "sales_count": 0,
            },
        )
        entry["leads_count"] = r["leads_count"]

    out = []
    for entry in sales_by_src.values():
        leads = entry.get("leads_count", 0)
        sales = entry.get("sales_count", 0)
        conv = round((sales / leads) * 100, 1) if leads else 0.0
        out.append(
            {
                **entry,
                "leads_count": leads,
                "conversion_pct": conv,
            }
        )
    out.sort(key=lambda x: (-float(x["total"] or 0), -x["leads_count"]))
    return out


def timeseries_daily(*, date_from, date_to) -> list[dict]:
    qs = _base_qs(date_from=date_from, date_to=date_to)
    rows = (
        qs.annotate(day=TruncDate("sold_at"))
        .values("day")
        .annotate(total=Sum(NET_AMOUNT), count=Count("id"))
        .order_by("day")
    )
    return [
        {"day": r["day"].isoformat(), "total": str(r["total"] or 0), "count": r["count"]}
        for r in rows
    ]


# ---- F3.C: extended lead distribution / funnel / heatmap -----------------

# Lead statuses grouped into buckets used by `leads_distribution_by_operator`.
# Each bucket is a semantically-tight stage so the FE can stack them.
_LEAD_STATUS_BUCKETS: dict[str, tuple[str, ...]] = {
    "new": ("new",),
    "assigned": ("assigned",),
    "in_progress": ("in_progress", "callback_scheduled", "contacted_telegram", "no_answer"),
    "won": ("won",),
    "lost": ("lost", "archived"),
    "needs_review": ("needs_review",),
}


def leads_distribution_by_operator() -> list[dict]:
    """
    Live active-lead counts per operator, grouped by high-level status
    bucket. Used by the F3.C stacked bar chart.

    Leads with no assigned operator are omitted (they belong to the
    round-robin queue, not to a person).
    """
    from django.db.models import IntegerField
    from django.db.models import Case, When

    from apps.leads.models import Lead

    inv: dict[str, str] = {}
    for bucket, statuses in _LEAD_STATUS_BUCKETS.items():
        for status in statuses:
            inv[status] = bucket

    lead_qs = Lead.objects.filter(operator__isnull=False)
    lead_qs = lead_qs.annotate(
        bucket=Case(
            *[When(status=s, then=Value(b, output_field=models.CharField()))
              for s, b in inv.items()],
            default=Value("other", output_field=models.CharField()),
            output_field=models.CharField(),
        )
    )

    # Aggregate to (operator_id, bucket) -> count
    rows = (
        lead_qs.values("operator_id", "operator__full_name", "bucket")
        .annotate(n=Count("id", output_field=IntegerField()))
    )

    per_operator: dict[int, dict] = {}
    for r in rows:
        oid = r["operator_id"]
        entry = per_operator.setdefault(
            oid,
            {
                "operator_id": oid,
                "operator_name": r["operator__full_name"],
                **{bucket: 0 for bucket in _LEAD_STATUS_BUCKETS},
                "total": 0,
            },
        )
        bucket = r["bucket"] if r["bucket"] in _LEAD_STATUS_BUCKETS else "in_progress"
        entry[bucket] += r["n"]
        entry["total"] += r["n"]

    return sorted(per_operator.values(), key=lambda x: -x["total"])


def operator_funnels(*, top_n: int = 10) -> list[dict]:
    """
    Per-operator funnel for the top-``top_n`` operators (by total leads).

    Stages:
      - leads_total  — # leads currently assigned or ever handled
      - contacted    — leads with ≥ 1 CallAttempt by this operator
      - callbacks    — leads with ≥ 1 pending/done CallbackReminder
      - sales        — leads whose status transitioned to `won`
    """
    from apps.calls.models import CallAttempt, CallbackReminder
    from apps.leads.models import Lead

    top_ops = list(
        Lead.objects.filter(operator__isnull=False)
        .values("operator_id", "operator__full_name")
        .annotate(n=Count("id"))
        .order_by("-n")[:top_n]
    )

    result = []
    for row in top_ops:
        oid = row["operator_id"]
        leads_total = row["n"]
        contacted = (
            CallAttempt.objects.filter(operator_id=oid)
            .values("lead_id")
            .distinct()
            .count()
        )
        callbacks = (
            CallbackReminder.objects.filter(operator_id=oid)
            .values("lead_id")
            .distinct()
            .count()
        )
        sales = Lead.objects.filter(operator_id=oid, status="won").count()
        result.append({
            "operator_id": oid,
            "operator_name": row["operator__full_name"],
            "leads_total": leads_total,
            "contacted": contacted,
            "callbacks": callbacks,
            "sales": sales,
        })
    return result


def callback_hour_heatmap(*, days_back: int = 30) -> dict:
    """
    Callback-activity heatmap over the last ``days_back`` days.

    Returns:
      {
        "operators": [{"id": ..., "name": ...}, ...],
        "hours": [0..23],
        "matrix": [[count, ...]]  # rows = operators, cols = hours
      }
    """
    from apps.calls.models import CallbackReminder
    from django.db.models.functions import ExtractHour

    cutoff = timezone.now() - dt.timedelta(days=days_back)

    rows = (
        CallbackReminder.objects.filter(remind_at__gte=cutoff)
        .annotate(hour=ExtractHour("remind_at"))
        .values("operator_id", "operator__full_name", "hour")
        .annotate(n=Count("id"))
    )

    op_map: dict[int, str] = {}
    grid: dict[tuple[int, int], int] = {}
    for r in rows:
        oid = r["operator_id"]
        op_map[oid] = r["operator__full_name"]
        grid[(oid, int(r["hour"] or 0))] = int(r["n"] or 0)

    operator_list = sorted(
        [{"id": oid, "name": name} for oid, name in op_map.items()],
        key=lambda x: x["name"] or "",
    )
    hours = list(range(24))
    matrix = [[grid.get((op["id"], h), 0) for h in hours] for op in operator_list]
    return {"operators": operator_list, "hours": hours, "matrix": matrix}


# ---- Manager lead stats ----------------------------------------------

# LeadStatus codes we consider "closed" for the daily-close chart.
_CLOSED_STATUS_CODES = {"won", "lost", "archived"}


def lead_stats_snapshot(
    *,
    date_from: dt.datetime | None,
    date_to: dt.datetime | None,
) -> dict:
    """
    Per-period lead breakdown for the manager stats page.

    Returns:
      {
        "total": int,
        "by_status": [{code, label_ru, label_uz, tone, emoji, count, pct}],
        "by_operator": [{operator_id, operator_name, total, won, lost,
                          in_progress, conversion_pct}],
        "daily": [{date: 'YYYY-MM-DD', created: N, won: N, lost: N}]
      }

    `created_at` bounds the leads that count; `won`/`lost` counts refer
    to those same leads and their CURRENT status (a lead created today
    that gets marked won today counts in both `created` and `won` for
    today).
    """
    from apps.leads.models import Lead, LeadStatusLabel

    qs = Lead.objects.all()
    if date_from:
        qs = qs.filter(created_at__gte=date_from)
    if date_to:
        qs = qs.filter(created_at__lte=date_to)

    total = qs.count()

    # ---- by_status: current status of each lead in the period.
    labels_map = {
        row.code: row
        for row in LeadStatusLabel.objects.filter(is_active=True)
    }
    raw_status = (
        qs.values("status")
        .annotate(count=Count("id"))
        .order_by("-count")
    )
    by_status: list[dict] = []
    for r in raw_status:
        code = r["status"] or "new"
        cnt = int(r["count"] or 0)
        lbl = labels_map.get(code)
        by_status.append(
            {
                "code": code,
                "label_ru": lbl.label_ru if lbl else code,
                "label_uz": lbl.label_uz if lbl else "",
                "tone": lbl.tone if lbl else "neutral",
                "emoji": lbl.emoji if lbl else "",
                "count": cnt,
                "pct": round(cnt * 100.0 / total, 1) if total else 0.0,
            }
        )

    # ---- by_operator: total + won/lost/in_progress + conversion.
    per_op_rows = (
        qs.exclude(operator__isnull=True)
        .values("operator_id", "operator__full_name")
        .annotate(
            total=Count("id"),
            won=Count("id", filter=models.Q(status="won")),
            lost=Count("id", filter=models.Q(status="lost")),
            in_progress=Count(
                "id",
                filter=~models.Q(status__in=("won", "lost", "archived")),
            ),
        )
        .order_by("-total")
    )
    by_operator: list[dict] = []
    for r in per_op_rows:
        t = int(r["total"] or 0)
        w = int(r["won"] or 0)
        by_operator.append(
            {
                "operator_id": r["operator_id"],
                "operator_name": r["operator__full_name"] or "",
                "total": t,
                "won": w,
                "lost": int(r["lost"] or 0),
                "in_progress": int(r["in_progress"] or 0),
                "conversion_pct": round(w * 100.0 / t, 1) if t else 0.0,
            }
        )

    # ---- daily: created / won / lost per calendar day in [from..to].
    daily: list[dict] = []
    if date_from and date_to:
        created_by_day = dict(
            qs.annotate(d=TruncDate("created_at"))
            .values_list("d")
            .annotate(n=Count("id"))
            .values_list("d", "n")
        )
        won_by_day = dict(
            qs.filter(status="won")
            .annotate(d=TruncDate("updated_at"))
            .values_list("d")
            .annotate(n=Count("id"))
            .values_list("d", "n")
        )
        lost_by_day = dict(
            qs.filter(status="lost")
            .annotate(d=TruncDate("updated_at"))
            .values_list("d")
            .annotate(n=Count("id"))
            .values_list("d", "n")
        )
        cursor = date_from.date()
        end = date_to.date()
        while cursor <= end:
            daily.append(
                {
                    "date": cursor.isoformat(),
                    "created": int(created_by_day.get(cursor, 0)),
                    "won": int(won_by_day.get(cursor, 0)),
                    "lost": int(lost_by_day.get(cursor, 0)),
                }
            )
            cursor = cursor + dt.timedelta(days=1)

    return {
        "total": total,
        "by_status": by_status,
        "by_operator": by_operator,
        "daily": daily,
    }

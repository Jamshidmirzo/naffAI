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
                          in_progress, sold_total, calls_total,
                          unique_leads_touched, conversion_pct}],
          - `won`        = leads со статусом "won" (продажи через лид)
          - `sold_total` = все confirmed sales оператора в периоде
                           (независимо от того, связаны с лидом или нет)
          - `calls_total` = всего CallAttempt в периоде у оператора
          - `unique_leads_touched` = уникальных лидов, коснулся звонком
        "daily": [{date: 'YYYY-MM-DD', created: N, won: N, lost: N}]
      }

    `created_at` bounds the leads that count; `won`/`lost` counts refer
    to those same leads and their CURRENT status (a lead created today
    that gets marked won today counts in both `created` and `won` for
    today).

    Активность звонков (`calls_total` / `unique_leads_touched`) считается
    по `CallAttempt.created_at` в том же окне.

    Wave-fix 2026-08-28: `by_operator.total/won/lost/in_progress` теперь
    считаются по семантике «лиды, которых оператор ТРОНУЛ (сделал ≥1 звонок)
    в период», а не «лиды, СОЗДАННЫЕ в период». Причина: user выбирал
    preset «Вчера» — график менялся, а колонки total/won/lost стояли на
    нулях, если оператор вчера обзванивал старых лидов (calls_total считался
    по CallAttempt.created_at, а total — по Lead.created_at → две разные
    вселенные). Теперь все 4 колонки живут в одной семантике touched-leads.
    """
    from collections import Counter, defaultdict

    from apps.calls.models import CallAttempt
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

    # ---- by_operator: touched-leads семантика.
    # total/won/lost/in_progress считаются по лидам, к которым оператор
    # прикоснулся ≥1 звонком в окне [date_from, date_to] — не по Lead.created_at.
    # Это даёт консистентные цифры между графиком и таблицей: если оператор
    # обзванивал вчера старых лидов, у него будет и calls_total>0, и total>0.
    #
    # Границы: используем тот же паттерн что calls.selectors.operator_activity_report()
    # — inclusive-right через exclusive-lt of (date_to.date + 1d) midnight в
    # текущей TZ (Asia/Tashkent). Но date_from/date_to сюда приходят уже как
    # tz-aware datetime (см. LeadStatsApi.get() — snap на dt.time.max), поэтому
    # мы просто используем __gte / __lte, что эквивалентно.
    calls_touched_qs = CallAttempt.objects.filter(operator__isnull=False)
    if date_from:
        calls_touched_qs = calls_touched_qs.filter(created_at__gte=date_from)
    if date_to:
        calls_touched_qs = calls_touched_qs.filter(created_at__lte=date_to)

    # (operator_id, lead_id) distinct → dict[op_id → set(lead_id)].
    by_op_leads: dict[int, set[int]] = defaultdict(set)
    for op_id, lead_id in (
        calls_touched_qs.values_list("operator_id", "lead_id").distinct()
    ):
        by_op_leads[int(op_id)].add(int(lead_id))

    all_touched: set[int] = set()
    for lead_ids in by_op_leads.values():
        all_touched.update(lead_ids)

    # One-shot fetch of current status для всех тронутых лидов.
    lead_status: dict[int, str] = {
        int(pk): (st or "")
        for pk, st in Lead.objects.filter(id__in=all_touched).values_list("id", "status")
    }

    # calls_total + unique_leads_touched per operator — те же aggregate'ы
    # что и раньше, но переиспользуем calls_touched_qs (совпадает по семантике
    # с by_op_leads → одна вселенная).
    calls_rows = calls_touched_qs.values("operator_id").annotate(
        total=Count("id"),
        unique_leads=Count("lead_id", distinct=True),
    )
    calls_map: dict[int, dict[str, int]] = {}
    for r in calls_rows:
        op_id = int(r["operator_id"])
        calls_map[op_id] = {
            "calls_total": int(r["total"] or 0),
            "unique_leads_touched": int(r["unique_leads"] or 0),
        }

    # Sold TOTAL by operator = every confirmed, non-returned, non-deleted
    # Sale where the operator is credited via SaleOperator (covers splits
    # too — a sale credited to A+B counts once for A AND once for B).
    # Independent от touched-leads (продажа могла быть без call attempt).
    sold_qs = SaleOperator.objects.filter(
        sale__status="confirmed",
        sale__is_deleted=False,
        sale__is_returned=False,
    )
    if date_from:
        sold_qs = sold_qs.filter(sale__sold_at__gte=date_from)
    if date_to:
        sold_qs = sold_qs.filter(sale__sold_at__lte=date_to)
    sold_rows = (
        sold_qs.exclude(operator__isnull=True)
        .values("operator_id")
        .annotate(n=Count("sale_id", distinct=True))
    )
    sold_map = {int(r["operator_id"]): int(r["n"] or 0) for r in sold_rows}

    # Собираем by_operator для операторов, у которых были звонки в окне.
    by_operator: list[dict] = []
    seen_op_ids: set[int] = set()
    op_names_touched = dict(
        Operator.objects.filter(id__in=by_op_leads.keys()).values_list("id", "full_name")
    )
    for op_id, lead_ids in by_op_leads.items():
        seen_op_ids.add(op_id)
        statuses = Counter(lead_status.get(lid, "") for lid in lead_ids)
        t = len(lead_ids)
        w = int(statuses.get("won", 0))
        lst = int(statuses.get("lost", 0))
        arch = int(statuses.get("archived", 0))
        in_prog = t - w - lst - arch
        calls_info = calls_map.get(op_id, {"calls_total": 0, "unique_leads_touched": 0})
        by_operator.append(
            {
                "operator_id": op_id,
                "operator_name": op_names_touched.get(op_id, ""),
                "total": t,
                "won": w,
                "lost": lst,
                "in_progress": in_prog,
                "sold_total": sold_map.get(op_id, 0),
                "calls_total": calls_info["calls_total"],
                "unique_leads_touched": calls_info["unique_leads_touched"],
                "conversion_pct": round(w * 100.0 / t, 1) if t else 0.0,
            }
        )

    # Include operators who have sales in this period but zero touched leads
    # — иначе «Sotildi (jami)» исчезнет у тех, ради кого эта метрика и
    # добавлялась (напр. dostik: 261 продажа, 0 лидов, 0 звонков). Также
    # покрывает старые записи в calls_map, которых нет в by_op_leads (если
    # такое возможно — safety net).
    missing_ids = (set(sold_map.keys()) | set(calls_map.keys())) - seen_op_ids
    if missing_ids:
        op_names_missing = dict(
            Operator.objects.filter(id__in=missing_ids).values_list("id", "full_name")
        )
        for op_id in missing_ids:
            calls_info = calls_map.get(
                op_id, {"calls_total": 0, "unique_leads_touched": 0}
            )
            by_operator.append(
                {
                    "operator_id": op_id,
                    "operator_name": op_names_missing.get(op_id, ""),
                    "total": 0,
                    "won": 0,
                    "lost": 0,
                    "in_progress": 0,
                    "sold_total": sold_map.get(op_id, 0),
                    "calls_total": calls_info["calls_total"],
                    "unique_leads_touched": calls_info["unique_leads_touched"],
                    "conversion_pct": 0.0,
                }
            )

    # Sort: touched-total DESC, tie-break sold_total → calls_total.
    by_operator.sort(
        key=lambda r: (r["total"], r["sold_total"], r["calls_total"]),
        reverse=True,
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


# ================================================================
# ---- Marketing analytics selectors (rich data for LLM + FE) ----
# ================================================================
#
# These selectors are the *raw material* the Marketing module feeds to the
# LLM analyst. They deliberately don't skew towards any particular chart:
# every metric relevant to a marketer (source performance, funnel,
# time-patterns, cohort, rejection reasons, WoW dynamics) is available
# so the LLM can compose evidence-heavy recommendations.
#
# All selectors:
#   * Include BOT/MANUAL leads (grouping label = "Bot" / "Manual")
#     alongside Google-Sheets sources — a real marketer cares about every
#     acquisition channel, not only the paid ones.
#   * Return plain JSON-serialisable dicts/lists (Decimal → str where
#     needed, no Django objects) so the marketing service can json.dumps()
#     the payload verbatim into the LLM prompt.
#   * Are pure reads — no side effects, no mutations.


def _source_label_from_lead(lead: dict) -> str:
    """Group key for a Lead row. `sheet_source__name` wins, else source enum."""
    sheet_name = lead.get("sheet_source__name")
    if sheet_name:
        return sheet_name
    src = lead.get("source") or ""
    if src == "bot":
        return "Telegram-бот"
    if src == "manual":
        return "Ручной ввод"
    return "Другое"


def _prev_period(start: dt.datetime, end: dt.datetime) -> tuple[dt.datetime, dt.datetime]:
    """Previous window of the same length, ending just before `start`."""
    span = end - start
    prev_end = start
    prev_start = prev_end - span
    return prev_start, prev_end


def _decimal_str(v) -> str:
    if v is None:
        return "0"
    return str(v)


def _source_leads_qs(*, date_from, date_to):
    """Leads created within [date_from, date_to]. Includes all sources."""
    from apps.leads.models import Lead

    qs = Lead.objects.all()
    if date_from:
        qs = qs.filter(created_at__gte=date_from)
    if date_to:
        qs = qs.filter(created_at__lte=date_to)
    return qs


def marketing_source_breakdown(
    *,
    date_from: dt.datetime,
    date_to: dt.datetime,
    top_lists_limit: int = 3,
) -> list[dict]:
    """
    Per-source breakdown for the LLM/dashboard: leads, converted, conv_rate,
    revenue, avg_check, top_products / top_operators, avg time-to-conv, WoW
    delta, and (if AdSpend rows exist for this window / source) spend/CAC/
    ROI/revenue-per-dollar. Includes BOT / MANUAL / SHEET-* alike.

    A "conversion" is a Sale whose linked `lead.created_at` is within the
    window AND whose `sheet_source_id` (denormalised on Sale) matches
    the group. For BOT/MANUAL leads without a sheet_source, the match is by
    `sale.lead.source`.
    """
    from apps.leads.models import Lead
    from apps.marketing.models import AdSpend

    # ---- Leads grouped by source label -----------------------------------
    lead_rows = list(
        _source_leads_qs(date_from=date_from, date_to=date_to)
        .values("id", "source", "sheet_source_id", "sheet_source__name", "created_at", "status")
    )

    groups: dict[str, dict] = {}
    lead_id_to_group: dict[int, str] = {}
    for r in lead_rows:
        label = _source_label_from_lead(r)
        g = groups.setdefault(
            label,
            {
                "source_name": label,
                "sheet_source_id": r["sheet_source_id"],
                "kind": (
                    "sheet" if r["sheet_source_id"]
                    else ("bot" if r["source"] == "bot" else "manual" if r["source"] == "manual" else "other")
                ),
                "lead_ids": [],
                "leads": 0,
            },
        )
        g["lead_ids"].append(r["id"])
        g["leads"] += 1
        lead_id_to_group[r["id"]] = label

    # ---- Sales linked back to those leads --------------------------------
    from apps.sales.models import Sale, SaleOperator

    lead_ids = list(lead_id_to_group.keys())
    sales_qs = Sale.objects.filter(
        is_deleted=False,
        is_returned=False,
        status="confirmed",
        lead_id__in=lead_ids,
    ).values("id", "lead_id", "amount", "discount", "phone_model", "sold_at", "created_at")
    sales_list = list(sales_qs)

    # Per-group sales aggregation.
    per_group_sales: dict[str, list[dict]] = {label: [] for label in groups}
    for s in sales_list:
        label = lead_id_to_group.get(s["lead_id"])
        if label:
            per_group_sales[label].append(s)

    # Sale IDs per group → for top_operators aggregation.
    sale_ids_by_group: dict[str, list[int]] = {
        label: [s["id"] for s in per_group_sales.get(label, [])]
        for label in groups
    }
    all_sale_ids = [sid for ids in sale_ids_by_group.values() for sid in ids]

    op_rows = list(
        SaleOperator.objects.filter(sale_id__in=all_sale_ids)
        .values("sale_id", "operator_id", "operator__full_name", "amount")
    )
    op_by_sale: dict[int, list[dict]] = {}
    for r in op_rows:
        op_by_sale.setdefault(r["sale_id"], []).append(r)

    # ---- Previous period for delta ---------------------------------------
    prev_start, prev_end = _prev_period(date_from, date_to)
    prev_lead_rows = list(
        Lead.objects.filter(created_at__gte=prev_start, created_at__lte=prev_end)
        .values("id", "source", "sheet_source_id", "sheet_source__name", "status")
    )
    prev_groups: dict[str, dict[str, int]] = {}
    prev_lead_ids_by_group: dict[str, list[int]] = {}
    for r in prev_lead_rows:
        label = _source_label_from_lead(r)
        g = prev_groups.setdefault(label, {"leads": 0, "converted": 0})
        g["leads"] += 1
        prev_lead_ids_by_group.setdefault(label, []).append(r["id"])
    # Count previous-period conversions by lead → sale existence.
    prev_all_lead_ids = [lid for ids in prev_lead_ids_by_group.values() for lid in ids]
    prev_won_lead_ids = set(
        Sale.objects.filter(
            is_deleted=False, is_returned=False, status="confirmed",
            lead_id__in=prev_all_lead_ids,
        ).values_list("lead_id", flat=True)
    )
    for label, ids in prev_lead_ids_by_group.items():
        prev_groups[label]["converted"] = sum(1 for lid in ids if lid in prev_won_lead_ids)

    # ---- AdSpend for the period per source label ------------------------
    ad_spend_map: dict[str, Decimal] = {}
    try:
        spend_qs = AdSpend.objects.filter(
            period_start__lte=date_to.date(),
            period_end__gte=date_from.date(),
        ).values("source_id", "source__name", "source_label", "amount")
        for r in spend_qs:
            if r["source__name"]:
                label = r["source__name"]
            elif r["source_label"]:
                label = r["source_label"]
            else:
                label = "Другое"
            ad_spend_map[label] = ad_spend_map.get(label, Decimal("0")) + (r["amount"] or Decimal("0"))
    except Exception:
        # AdSpend model may not exist yet during migration ordering.
        ad_spend_map = {}

    # ---- Assemble per-group payload --------------------------------------
    out: list[dict] = []
    for label, g in groups.items():
        sales_here = per_group_sales.get(label, [])
        converted = len(sales_here)
        leads = g["leads"]
        conv_rate = round(converted * 100.0 / leads, 2) if leads else 0.0

        # Net revenue = Σ (amount − discount).
        revenue = sum(
            (Decimal(str(s["amount"])) - Decimal(str(s.get("discount") or 0)))
            for s in sales_here
        ) if sales_here else Decimal("0")
        avg_check = (revenue / converted) if converted else Decimal("0")

        # Time-to-conversion (hours): sale.sold_at − lead.created_at
        lead_created_map = {r["id"]: r["created_at"] for r in lead_rows}
        deltas_hours: list[float] = []
        for s in sales_here:
            created = lead_created_map.get(s["lead_id"])
            if created and s["sold_at"]:
                deltas_hours.append((s["sold_at"] - created).total_seconds() / 3600.0)
        avg_time = round(sum(deltas_hours) / len(deltas_hours), 1) if deltas_hours else None

        # Top products.
        prod_counts: dict[str, int] = {}
        for s in sales_here:
            key = s.get("phone_model") or "—"
            prod_counts[key] = prod_counts.get(key, 0) + 1
        top_products = [
            {"name": k, "count": v}
            for k, v in sorted(prod_counts.items(), key=lambda x: -x[1])[:top_lists_limit]
        ]

        # Top operators (net credited).
        op_totals: dict[int, dict] = {}
        for sid in sale_ids_by_group.get(label, []):
            for line in op_by_sale.get(sid, []):
                oid = line["operator_id"]
                entry = op_totals.setdefault(
                    oid, {"operator_id": oid, "name": line["operator__full_name"] or "—", "count": 0, "total": Decimal("0")}
                )
                entry["count"] += 1
                entry["total"] += Decimal(str(line["amount"] or 0))
        top_operators = [
            {"operator_id": v["operator_id"], "name": v["name"], "count": v["count"], "total": _decimal_str(v["total"])}
            for v in sorted(op_totals.values(), key=lambda x: -x["total"])[:top_lists_limit]
        ]

        # Previous period comparison.
        prev = prev_groups.get(label, {"leads": 0, "converted": 0})
        prev_conv_rate = round(prev["converted"] * 100.0 / prev["leads"], 2) if prev["leads"] else 0.0
        delta_pp = round(conv_rate - prev_conv_rate, 2)
        delta_leads = leads - prev["leads"]

        # AdSpend / CAC / ROI.
        spend = ad_spend_map.get(label, Decimal("0"))
        cac = (spend / converted) if (spend and converted) else None
        roi = ((revenue - spend) / spend * 100) if spend else None
        rev_per_dollar = (revenue / spend) if spend else None

        out.append({
            "source_name": label,
            "sheet_source_id": g["sheet_source_id"],
            "kind": g["kind"],
            "leads": leads,
            "converted": converted,
            "conv_rate": conv_rate,
            "revenue": _decimal_str(revenue),
            "avg_check": _decimal_str(avg_check.quantize(Decimal("1"))) if converted else "0",
            "avg_time_to_conv_hours": avg_time,
            "top_products": top_products,
            "top_operators": top_operators,
            "prev_period": {
                "leads": prev["leads"],
                "converted": prev["converted"],
                "conv_rate": prev_conv_rate,
            },
            "delta_pp": delta_pp,
            "delta_leads": delta_leads,
            "adspend": {
                "amount": _decimal_str(spend),
                "cac": _decimal_str(cac.quantize(Decimal("1"))) if cac else None,
                "roi_pct": _decimal_str(roi.quantize(Decimal("0.1"))) if roi else None,
                "revenue_per_dollar": _decimal_str(rev_per_dollar.quantize(Decimal("0.01"))) if rev_per_dollar else None,
            },
        })

    out.sort(key=lambda x: -x["leads"])
    return out


def funnel_by_source(*, date_from: dt.datetime, date_to: dt.datetime) -> list[dict]:
    """
    Per-source funnel: current-status distribution over the enum stages
    + inter-stage pass-through percentages.
    """
    from apps.leads.models import Lead

    lead_rows = list(
        _source_leads_qs(date_from=date_from, date_to=date_to)
        .values("source", "sheet_source_id", "sheet_source__name", "status")
    )

    STAGES = ("new", "assigned", "in_progress", "contacted_telegram",
              "callback_scheduled", "no_answer", "won", "lost")

    per_src: dict[str, dict] = {}
    for r in lead_rows:
        label = _source_label_from_lead(r)
        entry = per_src.setdefault(
            label,
            {"source_name": label, **{s: 0 for s in STAGES}, "total": 0},
        )
        st = r["status"] or "new"
        # Merge no_answer_2 into no_answer for funnel purposes.
        if st == "no_answer_2":
            st = "no_answer"
        # Merge archived / needs_review into 'lost' bucket for funnel.
        if st in ("archived", "needs_review", "phone_on", "has_debt"):
            st = "lost" if st in ("archived", "needs_review") else st
        if st in entry:
            entry[st] += 1
        entry["total"] += 1

    out = []
    for entry in per_src.values():
        total = entry["total"] or 1
        # % of source total per stage
        stages_pct = {f"{s}_pct": round(entry[s] * 100.0 / total, 1) for s in STAGES}
        entry.update(stages_pct)
        out.append(entry)
    out.sort(key=lambda x: -x["total"])
    return out


def time_pattern_by_source(
    *,
    date_from: dt.datetime,
    date_to: dt.datetime,
    top_sources: int = 4,
) -> dict:
    """
    Hour-of-day pattern: for each of the top-`top_sources` sources (by leads),
    a 24-slot vector of `{leads_created, sales_converted}` counts. Also a
    global "all" row for the overall view.
    """
    from apps.leads.models import Lead
    from apps.sales.models import Sale

    lead_rows = list(
        _source_leads_qs(date_from=date_from, date_to=date_to)
        .values("id", "source", "sheet_source_id", "sheet_source__name", "created_at")
    )
    # Rank sources by leads → pick top-N (plus "all")
    from collections import Counter
    counts_by_src = Counter(_source_label_from_lead(r) for r in lead_rows)
    top_labels = [name for name, _ in counts_by_src.most_common(top_sources)]

    # Init structure: {source_name: [{"hour": h, "leads": 0, "sales": 0}, ...]}
    def _blank_hours():
        return [{"hour": h, "leads": 0, "sales": 0} for h in range(24)]

    per_src: dict[str, list[dict]] = {label: _blank_hours() for label in top_labels}
    per_src["Все источники"] = _blank_hours()

    lead_to_label: dict[int, str] = {}
    for r in lead_rows:
        label = _source_label_from_lead(r)
        lead_to_label[r["id"]] = label
        hour = int(r["created_at"].hour)
        per_src["Все источники"][hour]["leads"] += 1
        if label in per_src:
            per_src[label][hour]["leads"] += 1

    # Sales attributed via lead → group.
    lead_ids = [r["id"] for r in lead_rows]
    sale_rows = list(
        Sale.objects.filter(
            is_deleted=False, is_returned=False, status="confirmed",
            lead_id__in=lead_ids,
        ).values("lead_id", "sold_at")
    )
    for s in sale_rows:
        label = lead_to_label.get(s["lead_id"])
        if not label or not s["sold_at"]:
            continue
        hour = int(s["sold_at"].hour)
        per_src["Все источники"][hour]["sales"] += 1
        if label in per_src:
            per_src[label][hour]["sales"] += 1

    return {
        "sources": [
            {"source_name": name, "hours": hours}
            for name, hours in per_src.items()
        ]
    }


def rejection_reasons_by_source(
    *,
    date_from: dt.datetime,
    date_to: dt.datetime,
    top_n: int = 5,
) -> list[dict]:
    """
    Per-source top rejection reasons.

    Order of preference for the "reason" text:
      1. Sale.rejection_reason (managers can reject a submitted sale).
      2. Lead.postpone_reason  (proxy — often "передумал / нет денег").
      3. If none: lead status = 'lost' → generic "Потерян" bucket.

    Returns [{source_name, total_lost, reasons: [{text, count, pct}]}].
    """
    from apps.leads.models import Lead
    from apps.sales.models import Sale

    # 1) Lost leads (status='lost' OR 'archived') in period.
    lost_leads = list(
        _source_leads_qs(date_from=date_from, date_to=date_to)
        .filter(status__in=("lost", "archived"))
        .values("id", "source", "sheet_source_id", "sheet_source__name",
                "postpone_reason", "metadata")
    )

    per_src: dict[str, dict[str, int]] = {}
    per_src_total: dict[str, int] = {}
    for r in lost_leads:
        label = _source_label_from_lead(r)
        text = (r.get("postpone_reason") or "").strip()
        if not text:
            # Peek at metadata comment/IZOH for a hint.
            meta = r.get("metadata") or {}
            for k in ("IZOH", "izoh", "STATUS", "comment"):
                v = str(meta.get(k, "") or "").strip()
                if v:
                    text = v[:120]
                    break
        if not text:
            text = "Причина не указана"
        per_src.setdefault(label, {}).setdefault(text, 0)
        per_src[label][text] += 1
        per_src_total[label] = per_src_total.get(label, 0) + 1

    # 2) Rejected Sales (status='rejected') within period — attach to source.
    rejected = list(
        Sale.objects.filter(
            status="rejected",
            sold_at__gte=date_from,
            sold_at__lte=date_to,
        ).values("rejection_reason", "sheet_source_id", "sheet_source__name", "lead__source")
    )
    for r in rejected:
        # Reuse the same grouping fn.
        label = _source_label_from_lead({
            "source": r.get("lead__source") or "",
            "sheet_source_id": r.get("sheet_source_id"),
            "sheet_source__name": r.get("sheet_source__name"),
        })
        text = (r.get("rejection_reason") or "Отклонена менеджером").strip()[:120]
        per_src.setdefault(label, {}).setdefault(text, 0)
        per_src[label][text] += 1
        per_src_total[label] = per_src_total.get(label, 0) + 1

    out = []
    for label, reasons in per_src.items():
        total = per_src_total[label] or 1
        sorted_reasons = sorted(reasons.items(), key=lambda x: -x[1])[:top_n]
        out.append({
            "source_name": label,
            "total_lost": per_src_total[label],
            "reasons": [
                {"text": text, "count": cnt, "pct": round(cnt * 100.0 / total, 1)}
                for text, cnt in sorted_reasons
            ],
        })
    out.sort(key=lambda x: -x["total_lost"])
    return out


def wow_delta(*, date_from: dt.datetime, date_to: dt.datetime) -> dict:
    """
    Compare current window totals against the previous equal-length window.
    Returns absolute deltas + percentage change for leads/converted/revenue.
    """
    from apps.leads.models import Lead
    from apps.sales.models import Sale

    def _window(start, end):
        leads = Lead.objects.filter(created_at__gte=start, created_at__lte=end).count()
        # Conversions = sales whose linked lead was created in [start, end]
        # AND the sale is confirmed & non-returned & non-deleted.
        won = Sale.objects.filter(
            is_deleted=False, is_returned=False, status="confirmed",
            lead__created_at__gte=start, lead__created_at__lte=end,
        ).count()
        rev = (
            _base_qs(date_from=start, date_to=end).aggregate(t=Sum(NET_AMOUNT))["t"]
            or Decimal("0")
        )
        conv_rate = round(won * 100.0 / leads, 2) if leads else 0.0
        return leads, won, rev, conv_rate

    prev_start, prev_end = _prev_period(date_from, date_to)
    cur_leads, cur_conv, cur_rev, cur_rate = _window(date_from, date_to)
    prev_leads, prev_conv, prev_rev, prev_rate = _window(prev_start, prev_end)

    def _pct(cur, prev):
        if not prev:
            return None
        return round((cur - prev) * 100.0 / prev, 1)

    return {
        "current": {
            "leads": cur_leads,
            "converted": cur_conv,
            "revenue": _decimal_str(cur_rev),
            "conv_rate": cur_rate,
        },
        "previous": {
            "leads": prev_leads,
            "converted": prev_conv,
            "revenue": _decimal_str(prev_rev),
            "conv_rate": prev_rate,
        },
        "delta": {
            "leads_pct": _pct(cur_leads, prev_leads),
            "converted_pct": _pct(cur_conv, prev_conv),
            "revenue_pct": _pct(float(cur_rev), float(prev_rev)),
            "conv_rate_pp": round(cur_rate - prev_rate, 2),
        },
    }


def channel_source_matrix(*, date_from: dt.datetime, date_to: dt.datetime) -> list[dict]:
    """
    Which payment partner dominates for each acquisition source.
    Returns [{source_name, channels: [{name, count, share_pct}]}].
    """
    from apps.sales.models import Sale, SalePartner

    # Sales in period + their lead's source group.
    sale_rows = list(
        Sale.objects.filter(
            is_deleted=False, is_returned=False, status="confirmed",
            sold_at__gte=date_from, sold_at__lte=date_to,
        ).values(
            "id", "lead__source", "sheet_source_id", "sheet_source__name",
            "lead__sheet_source__name", "lead__sheet_source_id",
        )
    )
    sale_id_to_label: dict[int, str] = {}
    for r in sale_rows:
        # Prefer sale.sheet_source (denormalised); fall back to lead's.
        ss_name = r["sheet_source__name"] or r["lead__sheet_source__name"]
        ss_id = r["sheet_source_id"] or r["lead__sheet_source_id"]
        label = _source_label_from_lead({
            "source": r.get("lead__source") or "",
            "sheet_source_id": ss_id,
            "sheet_source__name": ss_name,
        })
        sale_id_to_label[r["id"]] = label

    sp_rows = list(
        SalePartner.objects.filter(sale_id__in=list(sale_id_to_label.keys()))
        .values("sale_id", "partner__name")
    )

    per_src_ch: dict[str, dict[str, int]] = {}
    per_src_total: dict[str, int] = {}
    for r in sp_rows:
        label = sale_id_to_label.get(r["sale_id"])
        name = r["partner__name"] or "Неизвестно"
        if not label:
            continue
        per_src_ch.setdefault(label, {}).setdefault(name, 0)
        per_src_ch[label][name] += 1
        per_src_total[label] = per_src_total.get(label, 0) + 1

    out = []
    for label, channels in per_src_ch.items():
        total = per_src_total[label] or 1
        out.append({
            "source_name": label,
            "total_partner_lines": per_src_total[label],
            "channels": [
                {
                    "name": name,
                    "count": cnt,
                    "share_pct": round(cnt * 100.0 / total, 1),
                }
                for name, cnt in sorted(channels.items(), key=lambda x: -x[1])
            ],
        })
    out.sort(key=lambda x: -x["total_partner_lines"])
    return out


def cohort_conversion(*, weeks_back: int = 8) -> list[dict]:
    """
    Weekly cohort: leads bucketed by ISO week of their `created_at`.
    For each cohort report:
      - leads_count  — cohort size
      - conv_7d      — # of leads that converted (Sale created) within 7d
      - conv_30d     — same but 30d
      - conv_rate_7d / _30d — pct
    """
    from apps.leads.models import Lead
    from apps.sales.models import Sale
    from django.db.models.functions import TruncWeek

    now = timezone.now()
    start = (now - dt.timedelta(weeks=weeks_back)).replace(
        hour=0, minute=0, second=0, microsecond=0
    )

    # Group leads by ISO week (via TruncWeek — Monday-anchored).
    lead_rows = list(
        Lead.objects.filter(created_at__gte=start)
        .annotate(week=TruncWeek("created_at"))
        .values("id", "created_at", "week")
    )

    # First-sale timestamp per lead.
    lead_ids = [r["id"] for r in lead_rows]
    sale_rows = list(
        Sale.objects.filter(
            is_deleted=False, is_returned=False, status="confirmed",
            lead_id__in=lead_ids,
        ).values("lead_id", "sold_at").order_by("sold_at")
    )
    first_sale: dict[int, dt.datetime] = {}
    for s in sale_rows:
        first_sale.setdefault(s["lead_id"], s["sold_at"])

    cohorts: dict[dt.datetime, dict] = {}
    for r in lead_rows:
        week = r["week"]
        entry = cohorts.setdefault(
            week,
            {
                "week": week.strftime("%Y-W%V"),
                "week_start": week.date().isoformat(),
                "leads_count": 0,
                "conv_7d": 0,
                "conv_30d": 0,
            },
        )
        entry["leads_count"] += 1
        ss = first_sale.get(r["id"])
        if ss:
            hours = (ss - r["created_at"]).total_seconds() / 3600.0
            if 0 <= hours <= 24 * 7:
                entry["conv_7d"] += 1
            if 0 <= hours <= 24 * 30:
                entry["conv_30d"] += 1

    out = []
    for week, entry in sorted(cohorts.items()):
        n = entry["leads_count"] or 1
        entry["conv_rate_7d"] = round(entry["conv_7d"] * 100.0 / n, 1)
        entry["conv_rate_30d"] = round(entry["conv_30d"] * 100.0 / n, 1)
        out.append(entry)
    return out


def marketing_totals(*, date_from: dt.datetime, date_to: dt.datetime) -> dict:
    """
    Compact totals row for the Overview tab KPI cards.
    """
    from apps.leads.models import Lead
    from apps.sales.models import Sale
    from apps.marketing.models import AdSpend

    leads = Lead.objects.filter(created_at__gte=date_from, created_at__lte=date_to).count()
    converted = Sale.objects.filter(
        is_deleted=False, is_returned=False, status="confirmed",
        lead__created_at__gte=date_from, lead__created_at__lte=date_to,
    ).count()
    conv_rate = round(converted * 100.0 / leads, 2) if leads else 0.0

    sales_agg = _base_qs(date_from=date_from, date_to=date_to).aggregate(
        total=Sum(NET_AMOUNT), count=Count("id")
    )
    revenue = sales_agg["total"] or Decimal("0")
    sales_count = sales_agg["count"] or 0
    avg_check = (revenue / sales_count) if sales_count else Decimal("0")

    try:
        spend = AdSpend.objects.filter(
            period_start__lte=date_to.date(),
            period_end__gte=date_from.date(),
        ).aggregate(t=Sum("amount"))["t"] or Decimal("0")
    except Exception:
        spend = Decimal("0")
    cac = (spend / converted) if (spend and converted) else None
    roi = ((revenue - spend) / spend * 100) if spend else None

    return {
        "leads": leads,
        "converted": converted,
        "conv_rate": conv_rate,
        "sales_count": sales_count,
        "revenue": _decimal_str(revenue),
        "avg_check": _decimal_str(avg_check.quantize(Decimal("1"))) if sales_count else "0",
        "spend": _decimal_str(spend),
        "cac": _decimal_str(cac.quantize(Decimal("1"))) if cac else None,
        "roi_pct": _decimal_str(roi.quantize(Decimal("0.1"))) if roi else None,
    }


# ==============================================================
# ---- Manager «Сводка дня» dashboard aggregate selector -------
# ==============================================================
#
# Aggregates every card + chart on the redesigned manager home into a
# single JSON response so the FE fires one request instead of six. It
# reuses the individual selectors above; no new business logic — pure
# composition + shape reformatting for the dashboard.


_DASHBOARD_TIMESERIES_DAYS = 14


def _period_bounds(
    period: str,
) -> tuple[dt.datetime, dt.datetime, dt.datetime, dt.datetime]:
    """
    Returns (cur_start, cur_end, prev_start, prev_end) datetimes anchored
    on now() in the active timezone. `period` ∈ {day, week, month}.

    - day    → today 00:00 … now, prev = yesterday 00:00 … 24:00
    - week   → Mon 00:00 … now, prev = prior Mon..Sun
    - month  → 1st 00:00 … now, prev = prior calendar month
    """
    now = timezone.now()
    start_of_day = now.replace(hour=0, minute=0, second=0, microsecond=0)

    if period == "day":
        cur_start = start_of_day
        cur_end = now
        prev_start = cur_start - dt.timedelta(days=1)
        prev_end = cur_start
        return cur_start, cur_end, prev_start, prev_end

    if period == "week":
        cur_start = start_of_day - dt.timedelta(days=now.weekday())
        cur_end = now
        prev_start = cur_start - dt.timedelta(days=7)
        prev_end = cur_start
        return cur_start, cur_end, prev_start, prev_end

    # month (default)
    cur_start = start_of_day.replace(day=1)
    cur_end = now
    # Prev month = full calendar month before `cur_start`.
    prev_end = cur_start
    if cur_start.month == 1:
        prev_start = cur_start.replace(year=cur_start.year - 1, month=12, day=1)
    else:
        prev_start = cur_start.replace(month=cur_start.month - 1, day=1)
    return cur_start, cur_end, prev_start, prev_end


def _sales_target_for_period(
    period: str, cur_start: dt.datetime
) -> dict:
    """
    Look up the applicable SalesTarget row for the current window.

    Falls back through: exact match → most recent row of the same period_type →
    `None`. Returns `{amount, count, period_type}` (Decimals stringified).
    """
    # Local import to avoid circular imports at module load.
    from .models import SalesTarget, SalesTargetPeriod

    period_type = {
        "day": SalesTargetPeriod.DAILY,
        "week": SalesTargetPeriod.WEEKLY,
        "month": SalesTargetPeriod.MONTHLY,
    }.get(period, SalesTargetPeriod.WEEKLY)

    anchor = cur_start.date()

    row = SalesTarget.objects.filter(
        period_type=period_type, period_start=anchor
    ).first()
    if row is None:
        # Fallback: most recent target of the same type (so old seed still shows).
        row = (
            SalesTarget.objects.filter(period_type=period_type)
            .order_by("-period_start")
            .first()
        )
    if row is None:
        return {"amount": None, "count": None, "period_type": period_type}

    return {
        "amount": _decimal_str(row.target_amount),
        "count": int(row.target_count),
        "period_type": period_type,
    }


def dashboard_summary(period: str = "week") -> dict:
    """
    Aggregate everything the manager «Сводка дня» dashboard needs.

    Composes existing selectors — no new business logic here. Shape is
    documented next to the endpoint (see `apis.DashboardSummaryApi`).
    """
    from apps.leads.selectors import orphan_leads
    from apps.sales.models import Sale
    from apps.attendance.selectors import attendance_dashboard_snapshot

    if period not in ("day", "week", "month"):
        period = "week"

    cur_start, cur_end, prev_start, prev_end = _period_bounds(period)

    # -------- today card (always today, независимо от period) --------
    now = timezone.now()
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    today_agg = _base_qs(date_from=today_start, date_to=now).aggregate(
        count=Count("id"), total=Sum(NET_AMOUNT)
    )
    pending_today = Sale.objects.filter(
        is_deleted=False, is_returned=False, status="pending"
    ).count()

    # -------- turnover card (period window, net) --------
    turnover_actual = _base_qs(date_from=cur_start, date_to=cur_end).aggregate(
        total=Sum(NET_AMOUNT)
    )["total"] or Decimal("0")
    target_row = _sales_target_for_period(period, cur_start)

    # -------- conversion card (leads → sales in window) --------
    from apps.leads.models import Lead

    def _leads_and_conv(start, end):
        leads_cnt = Lead.objects.filter(
            created_at__gte=start, created_at__lte=end
        ).count()
        conv_cnt = Sale.objects.filter(
            is_deleted=False, is_returned=False, status="confirmed",
            lead__created_at__gte=start, lead__created_at__lte=end,
        ).count()
        rate = round(conv_cnt * 100.0 / leads_cnt, 2) if leads_cnt else 0.0
        return leads_cnt, conv_cnt, rate

    _cur_leads, _cur_conv, cur_conv_rate = _leads_and_conv(cur_start, cur_end)
    _pr_leads, _pr_conv, prev_conv_rate = _leads_and_conv(prev_start, prev_end)
    delta_pp = round(cur_conv_rate - prev_conv_rate, 2)

    # -------- shift card --------
    shift = attendance_dashboard_snapshot()

    # -------- timeseries: last N days regardless of period tab --------
    ts_start = today_start - dt.timedelta(days=_DASHBOARD_TIMESERIES_DAYS - 1)
    ts_rows = timeseries_daily(date_from=ts_start, date_to=now)
    # Backfill missing days with zeros so the bar chart has fixed width.
    ts_by_day = {r["day"]: r for r in ts_rows}
    ts_filled: list[dict] = []
    cursor = ts_start.date()
    end_date = now.date()
    while cursor <= end_date:
        key = cursor.isoformat()
        r = ts_by_day.get(key)
        ts_filled.append(
            {
                "day": key,
                "count": int(r["count"]) if r else 0,
                "total": r["total"] if r else "0",
            }
        )
        cursor += dt.timedelta(days=1)

    # -------- attention: 4 counters --------
    orphans_cnt = orphan_leads().count()
    to_review = pending_today  # alias — Sale.status='pending' == «требует проверки»
    late_today = int(shift.get("late_today") or 0)

    # -------- leaderboard: top 5 for the SAME window as the KPIs --------
    top_ops = leaderboard(date_from=cur_start, date_to=cur_end, limit=5)
    top_ops_shaped = [
        {
            "id": r["operator_id"],
            "name": r["operator_name"],
            "count": r["count"],
            "amount": r["total"],
        }
        for r in top_ops
    ]

    return {
        "period": period,
        "today": {
            "count": int(today_agg["count"] or 0),
            "total": _decimal_str(today_agg["total"] or Decimal("0")),
            "pending_count": pending_today,
        },
        "turnover": {
            "actual": _decimal_str(turnover_actual),
            "target": target_row["amount"],
            "target_period": target_row["period_type"],
        },
        "conversion": {
            "value_pct": cur_conv_rate,
            "delta_pp": delta_pp,
            "prev_value_pct": prev_conv_rate,
        },
        "shift": {
            "on_shift": int(shift["on_shift"]),
            "expected": int(shift["expected"]),
            "late_today": late_today,
        },
        "timeseries": ts_filled,
        "target_daily_count": (
            # Дашборд рисует dashed-линию «план X шт./день» на бар-чарте.
            # Для weekly-плана делим на 7, для monthly — на 30, для daily —
            # используем как есть.
            None
            if target_row["count"] is None
            else (
                target_row["count"]
                if target_row["period_type"] == "daily"
                else max(1, round(target_row["count"] / (7 if target_row["period_type"] == "weekly" else 30)))
            )
        ),
        "attention": {
            "to_review": to_review,
            "orphans": orphans_cnt,
            "on_review": pending_today,
            "late_today": late_today,
        },
        "top_operators": top_ops_shaped,
    }

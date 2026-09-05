import datetime as dt

from django.core.cache import cache
from django.utils import timezone as djtz
from django.utils.dateparse import parse_datetime
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.common.excel import new_workbook, workbook_response, write_sheet
from apps.users.permissions import IsAuthenticatedAnyRole, IsTeamLeadOrManagerReadOnly

from .cache import (
    DASHBOARD_SUMMARY_TTL,
    LEAD_STATS_TTL,
    dashboard_summary_key,
    lead_stats_key,
)
from .selectors import (
    by_channel,
    by_model,
    callback_hour_heatmap,
    dashboard_summary,
    kpi_snapshot,
    lead_stats_snapshot,
    leaderboard,
    leads_distribution_by_operator,
    operator_funnels,
    resolve_period,
    sales_by_source,
    timeseries_daily,
)


def _parse(value):
    return parse_datetime(value) if value else None


def _window(request) -> tuple[dt.datetime | None, dt.datetime | None]:
    """
    Resolve `?period=day|week|month` first (auto-derived window),
    otherwise fall back to explicit `?date_from` / `?date_to`.
    """
    period = request.query_params.get("period")
    if period:
        p_from, p_to = resolve_period(period)
        if p_from is not None:
            return p_from, p_to
    return (
        _parse(request.query_params.get("date_from")),
        _parse(request.query_params.get("date_to")),
    )


class KpiApi(APIView):
    permission_classes = [IsTeamLeadOrManagerReadOnly]

    def get(self, request):
        # Explicit date_from/date_to override the period label; used by the
        # dashboard's month-picker (see FE `Dashboard.tsx`).
        date_from = _parse(request.query_params.get("date_from"))
        date_to = _parse(request.query_params.get("date_to"))
        return Response(
            kpi_snapshot(
                period=request.query_params.get("period"),
                date_from=date_from,
                date_to=date_to,
            )
        )


class LeaderboardApi(APIView):
    # Табло видно всем ролям (в т.ч. рядовому оператору — тот смотрит
    # своё место и подсвечивает себя в списке). Read-only, sensitive
    # данных нет (только имя + агрегаты).
    permission_classes = [IsAuthenticatedAnyRole]

    def get(self, request):
        date_from, date_to = _window(request)
        # limit=0 (or missing) → return every operator with sales in the window.
        # The screen dashboard relies on this to show the full ranking with the
        # top 5 visually highlighted and the tail scrollable.
        raw_limit = request.query_params.get("limit")
        limit = int(raw_limit) if raw_limit not in (None, "", "0") else None
        return Response(
            leaderboard(
                date_from=date_from,
                date_to=date_to,
                limit=limit,
            )
        )


class ByChannelApi(APIView):
    permission_classes = [IsTeamLeadOrManagerReadOnly]

    def get(self, request):
        date_from, date_to = _window(request)
        return Response(by_channel(date_from=date_from, date_to=date_to))


class BySourceApi(APIView):
    """Per-SheetSource sales + leads + conversion for the targetolog dashboard."""

    permission_classes = [IsTeamLeadOrManagerReadOnly]

    def get(self, request):
        date_from, date_to = _window(request)
        return Response(sales_by_source(date_from=date_from, date_to=date_to))


class ByModelApi(APIView):
    permission_classes = [IsTeamLeadOrManagerReadOnly]

    def get(self, request):
        date_from, date_to = _window(request)
        return Response(
            by_model(
                date_from=date_from,
                date_to=date_to,
                limit=int(request.query_params.get("limit", 20)),
            )
        )


class TimeseriesApi(APIView):
    permission_classes = [IsTeamLeadOrManagerReadOnly]

    def get(self, request):
        date_from, date_to = _window(request)
        if date_from is None:
            date_from = dt.datetime.now() - dt.timedelta(days=30)
        if date_to is None:
            date_to = dt.datetime.now()
        return Response(timeseries_daily(date_from=date_from, date_to=date_to))


# Guardrail for the merged manager stats page: the by_operator table
# blends leads + sales + calls, and calls-heavy days can produce huge
# aggregates. 92-дневное окно совпадает с operator_activity_report()
# (см. calls.selectors) — держим одну и ту же границу для консистентности.
LEAD_STATS_MAX_DAYS = 92


def _parse_date_ymd(value: str | None) -> dt.date | None:
    """Parse strict YYYY-MM-DD → date. Return None on empty/invalid."""
    if not value:
        return None
    try:
        return dt.datetime.strptime(value, "%Y-%m-%d").date()
    except ValueError:
        return None


class LeadStatsApi(APIView):
    """
    Manager stats page: total leads in the period + status/operator/daily
    breakdowns + per-operator call activity (calls_total,
    unique_leads_touched).

    Accepts:
      - `?period=day|week|month` — legacy, current-relative window
        (backwards compat with the old FE preset chips), OR
      - `?date_from=YYYY-MM-DD&date_to=YYYY-MM-DD` — explicit inclusive
        date range in Asia/Tashkent. Range must be ≤ 92 days.

    If both are supplied, explicit dates win (they are more precise).

    Wave-1 (2026-08-22): результат кешируется на 60 сек по (date_from,
    date_to). Инвалидация — в `sale_create` / `sale_confirm` / `sale_reject`
    / `sale_full_update` / `sale_partial_update` / `sale_mark_returned` /
    `sale_soft_delete` + `lead_update_status`.
    """

    permission_classes = [IsTeamLeadOrManagerReadOnly]

    def get(self, request):
        # 1) Explicit YYYY-MM-DD range (new FE default): parse, validate,
        # snap to local TZ midnights inclusive-inclusive.
        df_ymd = request.query_params.get("date_from")
        dt_ymd = request.query_params.get("date_to")
        if df_ymd or dt_ymd:
            # Both must be present together — otherwise a bare `date_from`
            # would silently degrade to "no upper bound", which is
            # confusing.
            if not (df_ymd and dt_ymd):
                return Response(
                    {"detail": "date_from и date_to должны быть заданы одновременно"},
                    status=400,
                )
            df_date = _parse_date_ymd(df_ymd)
            dt_date = _parse_date_ymd(dt_ymd)
            if df_date is None or dt_date is None:
                return Response(
                    {"detail": "Неверный формат даты, ожидается YYYY-MM-DD"},
                    status=400,
                )
            if df_date > dt_date:
                return Response(
                    {"detail": "date_from не может быть позже date_to"},
                    status=400,
                )
            span_days = (dt_date - df_date).days + 1
            if span_days > LEAD_STATS_MAX_DAYS:
                return Response(
                    {"detail": f"Слишком большой диапазон: {span_days} дн. > {LEAD_STATS_MAX_DAYS} дн."},
                    status=400,
                )
            tz = djtz.get_current_timezone()
            date_from = dt.datetime.combine(df_date, dt.time.min, tzinfo=tz)
            # inclusive-right: до конца календарного дня, чтобы 23:59 попал в окно
            date_to = dt.datetime.combine(dt_date, dt.time.max, tzinfo=tz)
        else:
            # 2) Legacy path: ?period=day|week|month → resolve_period()
            # gives (start, now); if `period` missing / unknown, default
            # to today (matches previous behaviour + FE default tab).
            date_from, date_to = _window(request)
            if date_from is None:
                now = djtz.now()
                date_from = now.replace(hour=0, minute=0, second=0, microsecond=0)
                date_to = now

        key = lead_stats_key(
            date_from.isoformat(),
            date_to.isoformat(),
        )
        payload = cache.get_or_set(
            key,
            lambda: lead_stats_snapshot(date_from=date_from, date_to=date_to),
            timeout=LEAD_STATS_TTL,
        )
        return Response(payload)


class LeadsDistributionApi(APIView):
    """
    F3.C-1 — stacked bar chart data: active leads per operator, grouped by
    high-level status bucket.
    """

    permission_classes = [IsTeamLeadOrManagerReadOnly]

    def get(self, request):
        return Response(leads_distribution_by_operator())


class OperatorFunnelsApi(APIView):
    """
    F3.C-2 — small-multiples funnel: per-operator leads → contacted →
    callbacks → sales.
    """

    permission_classes = [IsTeamLeadOrManagerReadOnly]

    def get(self, request):
        top_n = int(request.query_params.get("top_n", 10))
        return Response(operator_funnels(top_n=top_n))


class CallbackHeatmapApi(APIView):
    """
    F3.C-3 — hour-of-day heatmap of callback reminders per operator.
    """

    permission_classes = [IsTeamLeadOrManagerReadOnly]

    def get(self, request):
        days_back = int(request.query_params.get("days_back", 30))
        return Response(callback_hour_heatmap(days_back=days_back))


class DashboardSummaryApi(APIView):
    """
    GET /api/analytics/dashboard-summary/?period=day|week|month  (default: week)

    Единый endpoint для менеджерской главной «Сводка дня» — собирает всё,
    что нужно верхнему ряду KPI-карточек, среднему ряду (бар-чарт + «требует
    решения») и нижнему ряду (топ операторов) одним ответом. Внутри просто
    композиция уже существующих селекторов.

    Форма ответа:
      {
        "period": "week",
        "today":       {"count": N, "total": "X", "pending_count": N},
        "turnover":    {"actual": "X", "target": "Y"|null, "target_period": "..."},
        "conversion":  {"value_pct": F, "delta_pp": F, "prev_value_pct": F},
        "shift":       {"on_shift": N, "expected": M, "late_today": K},
        "timeseries":  [{"day": "YYYY-MM-DD", "count": N, "total": "X"}, ...14],
        "target_daily_count": N|null,
        "attention":   {"to_review": N, "orphans": N, "on_review": N, "late_today": N},
        "top_operators":[{"id": N, "name": "...", "count": N, "amount": "X"}, ...5]
      }
    """

    permission_classes = [IsTeamLeadOrManagerReadOnly]

    def get(self, request):
        period = (request.query_params.get("period") or "week").lower()
        month = (request.query_params.get("month") or "").strip() or None
        if month:
            # Конкретный месяц («посмотреть август и посчитать ЗП») —
            # мимо кэша: исторический месяц не меняется, а гонять
            # invalidation для произвольных YYYY-MM не хотим.
            return Response(dashboard_summary(period=period, month=month))
        # Wave-1 (2026-08-22): каждая mutation'а Sale инвалидирует все три
        # известные значения period одним delete_many — держатся синхронно
        # с реальностью в пределах commit'а mutation.
        key = dashboard_summary_key(period)
        payload = cache.get_or_set(
            key,
            lambda: dashboard_summary(period=period),
            timeout=DASHBOARD_SUMMARY_TTL,
        )
        return Response(payload)


class AnalyticsExportApi(APIView):
    permission_classes = [IsTeamLeadOrManagerReadOnly]

    def get(self, request):
        date_from, date_to = _window(request)

        wb = new_workbook()

        lb = leaderboard(date_from=date_from, date_to=date_to, limit=100)
        write_sheet(
            wb,
            title="Лидерборд",
            headers=["Оператор", "Стажёр", "Кол-во", "Сумма", "Средний чек"],
            rows=[
                [
                    r["operator_name"],
                    "да" if r["is_trainee"] else "нет",
                    r["count"],
                    float(r["total"]),
                    float(r["avg_ticket"]),
                ]
                for r in lb
            ],
            money_columns=[3, 4],
            int_columns=[2],
            totals_row=[
                "ИТОГО",
                "",
                sum(r["count"] for r in lb),
                sum(float(r["total"]) for r in lb),
                "",
            ],
        )

        ch = by_channel(date_from=date_from, date_to=date_to)
        write_sheet(
            wb,
            title="Каналы",
            headers=["Канал", "Кол-во", "Сумма"],
            rows=[[r["channel_name"], r["count"], float(r["total"])] for r in ch],
            money_columns=[2],
            int_columns=[1],
            totals_row=["ИТОГО", sum(r["count"] for r in ch), sum(float(r["total"]) for r in ch)],
        )

        md = by_model(date_from=date_from, date_to=date_to, limit=200)
        write_sheet(
            wb,
            title="Модели",
            headers=["Модель", "Кол-во", "Сумма"],
            rows=[[r["phone_model"], r["count"], float(r["total"])] for r in md],
            money_columns=[2],
            int_columns=[1],
        )

        return workbook_response(wb, "analytics.xlsx")

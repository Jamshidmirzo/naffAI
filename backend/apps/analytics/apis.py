import datetime as dt

from django.utils.dateparse import parse_datetime
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.common.excel import new_workbook, workbook_response, write_sheet
from apps.users.permissions import IsTeamLeadOrManagerReadOnly

from .selectors import (
    by_channel,
    by_model,
    callback_hour_heatmap,
    kpi_snapshot,
    leaderboard,
    leads_distribution_by_operator,
    operator_funnels,
    resolve_period,
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
    permission_classes = [IsTeamLeadOrManagerReadOnly]

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

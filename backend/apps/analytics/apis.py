import datetime as dt

from django.utils.dateparse import parse_datetime
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.common.excel import new_workbook, workbook_response, write_sheet
from apps.users.permissions import IsTeamLeadOrManagerReadOnly

from .selectors import (
    by_channel,
    by_model,
    kpi_snapshot,
    leaderboard,
    timeseries_daily,
)


def _parse(value):
    return parse_datetime(value) if value else None


class KpiApi(APIView):
    permission_classes = [IsTeamLeadOrManagerReadOnly]

    def get(self, request):
        return Response(kpi_snapshot())


class LeaderboardApi(APIView):
    permission_classes = [IsTeamLeadOrManagerReadOnly]

    def get(self, request):
        return Response(
            leaderboard(
                date_from=_parse(request.query_params.get("date_from")),
                date_to=_parse(request.query_params.get("date_to")),
                limit=int(request.query_params.get("limit", 20)),
            )
        )


class ByChannelApi(APIView):
    permission_classes = [IsTeamLeadOrManagerReadOnly]

    def get(self, request):
        return Response(
            by_channel(
                date_from=_parse(request.query_params.get("date_from")),
                date_to=_parse(request.query_params.get("date_to")),
            )
        )


class ByModelApi(APIView):
    permission_classes = [IsTeamLeadOrManagerReadOnly]

    def get(self, request):
        return Response(
            by_model(
                date_from=_parse(request.query_params.get("date_from")),
                date_to=_parse(request.query_params.get("date_to")),
                limit=int(request.query_params.get("limit", 20)),
            )
        )


class TimeseriesApi(APIView):
    permission_classes = [IsTeamLeadOrManagerReadOnly]

    def get(self, request):
        date_from = _parse(request.query_params.get("date_from")) or (
            dt.datetime.now() - dt.timedelta(days=30)
        )
        date_to = _parse(request.query_params.get("date_to")) or dt.datetime.now()
        return Response(timeseries_daily(date_from=date_from, date_to=date_to))


class AnalyticsExportApi(APIView):
    permission_classes = [IsTeamLeadOrManagerReadOnly]

    def get(self, request):
        date_from = _parse(request.query_params.get("date_from"))
        date_to = _parse(request.query_params.get("date_to"))

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

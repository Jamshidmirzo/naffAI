from __future__ import annotations

import datetime as dt
from decimal import Decimal, InvalidOperation

from django.utils.dateparse import parse_date
from rest_framework import serializers, status
from rest_framework.generics import ListAPIView
from rest_framework.permissions import BasePermission
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.common.excel import new_workbook, workbook_response, write_sheet
from apps.users.models import Role
from apps.users.permissions import IsSuperadminOrManager, IsTeamLeadOrManagerReadOnly

from .models import AdSpend, MarketingInsight
from .selectors import (
    adspend_filtered,
    insights_list,
    latest_insight,
)
from .services import (
    adspend_create,
    adspend_delete,
    adspend_update,
    build_dashboard_payload,
    generate_marketing_insight,
    mark_recommendation_done,
)


# ---- Permissions -----------------------------------------------------


class IsTeamLeadOrManager(BasePermission):
    """Legacy — kept for the old endpoints. Prefer IsSuperadminOrManager."""

    def has_permission(self, request, view) -> bool:
        user = request.user
        if not user or not user.is_authenticated:
            return False
        if user.is_superuser:
            return True
        profile = getattr(user, "profile", None)
        role = profile.role if profile else None
        return role in {Role.TEAM_LEAD, Role.MANAGER, Role.SUPERADMIN}


# ---- Serializers -----------------------------------------------------


class InsightSerializer(serializers.ModelSerializer):
    class Meta:
        model = MarketingInsight
        fields = [
            "id",
            "period_start",
            "period_end",
            "lead_quality_by_source",
            "targeting_recommendations",
            "top_products",
            "summary",
            "model_version",
            "provider_used",
            "structured_output",
            "actions_taken",
            "dashboard_payload_snapshot",
            "created_at",
            "updated_at",
        ]


class AdSpendSerializer(serializers.ModelSerializer):
    resolved_label = serializers.CharField(read_only=True)
    source_name = serializers.SerializerMethodField()

    class Meta:
        model = AdSpend
        fields = [
            "id",
            "period_start",
            "period_end",
            "source",
            "source_label",
            "source_name",
            "resolved_label",
            "amount",
            "currency",
            "note",
            "created_by",
            "created_at",
            "updated_at",
        ]
        read_only_fields = ["created_by", "created_at", "updated_at"]

    def get_source_name(self, obj: AdSpend) -> str:
        if obj.source_id and obj.source:
            return obj.source.name
        return obj.source_label or "Другое"


# ---- Legacy insight endpoints (preserved) ----------------------------


class InsightsListApi(ListAPIView):
    permission_classes = [IsTeamLeadOrManagerReadOnly]
    serializer_class = InsightSerializer

    def get_queryset(self):
        return insights_list(limit=20)


class LatestInsightApi(APIView):
    permission_classes = [IsTeamLeadOrManagerReadOnly]

    def get(self, request):
        row = latest_insight()
        if not row:
            return Response({"detail": "No insight yet"}, status=404)
        return Response(InsightSerializer(row).data)


class InsightDetailApi(APIView):
    permission_classes = [IsTeamLeadOrManagerReadOnly]

    def get(self, request, insight_id: int):
        try:
            row = MarketingInsight.objects.get(pk=insight_id)
        except MarketingInsight.DoesNotExist:
            return Response({"detail": "not found"}, status=404)
        return Response(InsightSerializer(row).data)


class GenerateInsightApi(APIView):
    permission_classes = [IsTeamLeadOrManager]

    def post(self, request):
        # Accept either JSON body or query params. Fallback: 30 days.
        days_raw = (request.data or {}).get("days") or request.query_params.get("days") or 30
        try:
            days = int(days_raw)
        except (TypeError, ValueError):
            days = 30
        days = max(1, min(days, 365))
        end = dt.date.today()
        start = end - dt.timedelta(days=days - 1)
        insight = generate_marketing_insight(period_start=start, period_end=end, user=request.user)
        return Response(InsightSerializer(insight).data)


class MarkRecommendationDoneApi(APIView):
    """POST /marketing/insights/{id}/recommendations/{index}/mark_done/ — toggle."""

    permission_classes = [IsTeamLeadOrManager]

    def post(self, request, insight_id: int, index: int):
        try:
            row = mark_recommendation_done(
                insight_id=insight_id, index=int(index), user=request.user
            )
        except MarketingInsight.DoesNotExist:
            return Response({"detail": "insight not found"}, status=404)
        except ValueError as exc:
            return Response({"detail": str(exc)}, status=400)
        return Response(InsightSerializer(row).data)


# ---- Dashboard payload -----------------------------------------------


def _parse_period(request) -> tuple[dt.date, dt.date]:
    df_raw = request.query_params.get("date_from")
    dt_raw = request.query_params.get("date_to")
    end = parse_date(dt_raw) if dt_raw else dt.date.today()
    start = parse_date(df_raw) if df_raw else end - dt.timedelta(days=29)
    if start > end:
        start, end = end, start
    return start, end


class MarketingDashboardApi(APIView):
    """
    GET /marketing/dashboard/?date_from=YYYY-MM-DD&date_to=YYYY-MM-DD

    Returns the full marketing payload (totals, sources, funnels,
    time_patterns, rejection_reasons, channels, cohorts, wow,
    adspend_summary) + the latest insight's id if any.
    """

    permission_classes = [IsTeamLeadOrManagerReadOnly]

    def get(self, request):
        start, end = _parse_period(request)
        payload = build_dashboard_payload(period_start=start, period_end=end)
        latest = latest_insight()
        payload["latest_insight_id"] = latest.id if latest else None
        payload["latest_insight_generated_at"] = (
            latest.updated_at.isoformat() if latest else None
        )
        return Response(payload)


# ---- AdSpend CRUD ----------------------------------------------------


class AdSpendListCreateApi(APIView):
    """
    GET  /marketing/adspend/?date_from=&date_to=&source=
    POST /marketing/adspend/
    """

    permission_classes = [IsSuperadminOrManager]

    def get(self, request):
        df_raw = request.query_params.get("date_from")
        dt_raw = request.query_params.get("date_to")
        src_raw = request.query_params.get("source")
        df = parse_date(df_raw) if df_raw else None
        de = parse_date(dt_raw) if dt_raw else None
        src_id = None
        if src_raw and src_raw.isdigit():
            src_id = int(src_raw)
        rows = adspend_filtered(date_from=df, date_to=de, source_id=src_id)
        return Response(AdSpendSerializer(rows, many=True).data)

    def post(self, request):
        data = request.data or {}
        try:
            period_start = parse_date(data.get("period_start"))
            period_end = parse_date(data.get("period_end"))
            if not period_start or not period_end:
                return Response({"detail": "period_start / period_end required"}, status=400)
            amount = Decimal(str(data.get("amount")))
        except (InvalidOperation, TypeError, ValueError) as exc:
            return Response({"detail": f"invalid input: {exc}"}, status=400)

        source_id = data.get("source") or data.get("source_id")
        if source_id in ("", None):
            source_id = None
        try:
            row = adspend_create(
                period_start=period_start,
                period_end=period_end,
                source_id=int(source_id) if source_id else None,
                source_label=str(data.get("source_label") or "").strip(),
                amount=amount,
                note=str(data.get("note") or ""),
                currency=str(data.get("currency") or "UZS"),
                user=request.user,
            )
        except ValueError as exc:
            return Response({"detail": str(exc)}, status=400)
        return Response(AdSpendSerializer(row).data, status=201)


class AdSpendDetailApi(APIView):
    """PATCH / DELETE /marketing/adspend/{id}/"""

    permission_classes = [IsSuperadminOrManager]

    def patch(self, request, adspend_id: int):
        try:
            row = AdSpend.objects.get(pk=adspend_id)
        except AdSpend.DoesNotExist:
            return Response({"detail": "not found"}, status=404)
        fields: dict = {}
        data = request.data or {}
        if "period_start" in data:
            fields["period_start"] = parse_date(data["period_start"])
        if "period_end" in data:
            fields["period_end"] = parse_date(data["period_end"])
        if "source" in data:
            v = data["source"]
            fields["source_id"] = int(v) if v not in ("", None) else None
        if "source_id" in data:
            v = data["source_id"]
            fields["source_id"] = int(v) if v not in ("", None) else None
        if "source_label" in data:
            fields["source_label"] = str(data["source_label"] or "").strip()
        if "amount" in data:
            try:
                fields["amount"] = Decimal(str(data["amount"]))
            except (InvalidOperation, TypeError, ValueError) as exc:
                return Response({"detail": f"invalid amount: {exc}"}, status=400)
        if "currency" in data:
            fields["currency"] = str(data["currency"] or "UZS")
        if "note" in data:
            fields["note"] = str(data["note"] or "")
        try:
            row = adspend_update(row_id=row.id, fields=fields, user=request.user)
        except ValueError as exc:
            return Response({"detail": str(exc)}, status=400)
        return Response(AdSpendSerializer(row).data)

    def delete(self, request, adspend_id: int):
        try:
            adspend_delete(row_id=adspend_id, user=request.user)
        except AdSpend.DoesNotExist:
            return Response({"detail": "not found"}, status=404)
        return Response(status=204)


# ---- Excel export ----------------------------------------------------


class MarketingExportApi(APIView):
    """
    GET /marketing/export.xlsx/?date_from=&date_to=

    Multi-sheet: Sources, Funnels, Top Products (flat), AdSpend,
    Recommendations (latest insight).
    """

    permission_classes = [IsTeamLeadOrManagerReadOnly]

    def get(self, request):
        start, end = _parse_period(request)
        payload = build_dashboard_payload(period_start=start, period_end=end)
        latest = latest_insight()
        structured = latest.structured_output if latest else {}

        wb = new_workbook()

        # Sheet 1: Sources.
        sources = payload.get("sources") or []
        write_sheet(
            wb,
            title="Источники",
            headers=[
                "Источник", "Тип", "Лиды", "Продажи", "Конверсия %",
                "Выручка", "Средний чек", "Часы до конверсии", "Δ pp",
                "Расход рекламы", "CAC", "ROI %",
            ],
            rows=[
                [
                    s.get("source_name") or "—",
                    s.get("kind") or "—",
                    s.get("leads", 0),
                    s.get("converted", 0),
                    s.get("conv_rate", 0.0),
                    float(s.get("revenue") or 0),
                    float(s.get("avg_check") or 0),
                    s.get("avg_time_to_conv_hours") or "",
                    s.get("delta_pp", 0),
                    float((s.get("adspend") or {}).get("amount") or 0),
                    float((s.get("adspend") or {}).get("cac") or 0),
                    float((s.get("adspend") or {}).get("roi_pct") or 0),
                ]
                for s in sources
            ],
            money_columns=[5, 6, 9, 10],
            int_columns=[2, 3],
            totals_row=[
                "ИТОГО",
                "",
                sum(int(s.get("leads", 0)) for s in sources),
                sum(int(s.get("converted", 0)) for s in sources),
                "",
                sum(float(s.get("revenue") or 0) for s in sources),
                "", "", "",
                sum(float((s.get("adspend") or {}).get("amount") or 0) for s in sources),
                "", "",
            ],
        )

        # Sheet 2: Funnels.
        funnels = payload.get("funnels") or []
        write_sheet(
            wb,
            title="Воронка",
            headers=[
                "Источник", "Всего", "Новые", "Назначены", "В работе",
                "TG", "Callback", "Не ответил", "Продажа", "Потерян",
            ],
            rows=[
                [
                    f.get("source_name") or "—",
                    f.get("total", 0),
                    f.get("new", 0),
                    f.get("assigned", 0),
                    f.get("in_progress", 0),
                    f.get("contacted_telegram", 0),
                    f.get("callback_scheduled", 0),
                    f.get("no_answer", 0),
                    f.get("won", 0),
                    f.get("lost", 0),
                ]
                for f in funnels
            ],
            int_columns=list(range(1, 10)),
        )

        # Sheet 3: Top products (flat).
        prod_rows = []
        for s in sources:
            for p in s.get("top_products", []) or []:
                prod_rows.append([s.get("source_name") or "—", p.get("name"), p.get("count", 0)])
        write_sheet(
            wb,
            title="Модели",
            headers=["Источник", "Модель", "Кол-во"],
            rows=prod_rows,
            int_columns=[2],
        )

        # Sheet 4: AdSpend.
        spends = list(
            AdSpend.objects.filter(
                period_start__lte=end, period_end__gte=start
            ).select_related("source")
        )
        write_sheet(
            wb,
            title="Расход рекламы",
            headers=["С", "По", "Источник", "Сумма", "Валюта", "Заметка"],
            rows=[
                [
                    s.period_start.isoformat(),
                    s.period_end.isoformat(),
                    s.resolved_label,
                    float(s.amount),
                    s.currency,
                    s.note or "",
                ]
                for s in spends
            ],
            money_columns=[3],
            totals_row=["", "", "ИТОГО", sum(float(s.amount) for s in spends), "", ""],
        )

        # Sheet 5: Recommendations from latest insight.
        recs = (structured or {}).get("recommendations") or []
        write_sheet(
            wb,
            title="Рекомендации",
            headers=["Приоритет", "Действие", "Источник", "Обоснование", "Эффект", "Уверенность"],
            rows=[
                [
                    r.get("priority", ""),
                    r.get("action", ""),
                    r.get("source", ""),
                    r.get("evidence", ""),
                    r.get("expected_impact", ""),
                    r.get("confidence", ""),
                ]
                for r in recs
            ],
        )

        return workbook_response(wb, f"marketing_{start.isoformat()}_{end.isoformat()}.xlsx")

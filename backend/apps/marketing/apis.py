from __future__ import annotations

import datetime as dt

from rest_framework import serializers
from rest_framework.generics import ListAPIView
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.users.models import Role
from apps.users.permissions import IsTeamLeadOrManagerReadOnly
from rest_framework.permissions import BasePermission


class IsTeamLeadOrManager(BasePermission):
    def has_permission(self, request, view) -> bool:
        user = request.user
        if not user or not user.is_authenticated:
            return False
        if user.is_superuser:
            return True
        profile = getattr(user, "profile", None)
        role = profile.role if profile else None
        return role in {Role.TEAM_LEAD, Role.MANAGER}

from .models import MarketingInsight
from .selectors import insights_list, latest_insight
from .services import generate_marketing_insight


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
            "created_at",
        ]


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


class GenerateInsightApi(APIView):
    permission_classes = [IsTeamLeadOrManager]

    def post(self, request):
        days = int((request.data or {}).get("days", 7))
        end = dt.date.today()
        start = end - dt.timedelta(days=days - 1)
        insight = generate_marketing_insight(period_start=start, period_end=end, user=request.user)
        return Response(InsightSerializer(insight).data)

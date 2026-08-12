"""
Installment bank + plan CRUD. Manager-only. Small enough for a single
file; no separate service layer needed.
"""

from __future__ import annotations

from rest_framework import serializers, viewsets

from apps.users.permissions import IsTeamLead

from .models import InstallmentBank, InstallmentPlan


class InstallmentPlanSerializer(serializers.ModelSerializer):
    class Meta:
        model = InstallmentPlan
        fields = ["id", "bank", "term_months", "multiplier", "is_active", "sort_order"]


class InstallmentBankSerializer(serializers.ModelSerializer):
    plans = InstallmentPlanSerializer(many=True, read_only=True)

    class Meta:
        model = InstallmentBank
        fields = ["id", "name", "icon", "is_active", "sort_order", "plans"]


class InstallmentBankViewSet(viewsets.ModelViewSet):
    permission_classes = [IsTeamLead]
    serializer_class = InstallmentBankSerializer
    queryset = InstallmentBank.objects.all().prefetch_related("plans")


class InstallmentPlanViewSet(viewsets.ModelViewSet):
    permission_classes = [IsTeamLead]
    serializer_class = InstallmentPlanSerializer
    queryset = InstallmentPlan.objects.all()

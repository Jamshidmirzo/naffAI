"""
Thin DRF views для управления системными настройками.
Только менеджер может читать/менять.
"""

from __future__ import annotations

from rest_framework import serializers
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.users.permissions import IsManager

from .selectors import system_setting_get
from .services import system_setting_update


class DistributionSettingsSerializer(serializers.Serializer):
    auto_distribution_enabled = serializers.BooleanField()
    morning_gate_enabled = serializers.BooleanField()
    updated_at = serializers.DateTimeField()
    updated_by = serializers.SerializerMethodField()

    def get_updated_by(self, obj):
        user = obj.updated_by
        if not user:
            return None
        full_name = (
            getattr(getattr(user, "profile", None), "full_name", None)
            or f"{user.first_name} {user.last_name}".strip()
            or user.username
        )
        return {"id": user.id, "full_name": full_name}


class DistributionSettingsUpdateSerializer(serializers.Serializer):
    # Оба поля опциональны — фронт шлёт только тот тумблер, что двигают.
    auto_distribution_enabled = serializers.BooleanField(required=False)
    morning_gate_enabled = serializers.BooleanField(required=False)

    def validate(self, attrs):
        if not attrs:
            raise serializers.ValidationError(
                "передайте хотя бы один флаг: auto_distribution_enabled или morning_gate_enabled"
            )
        return attrs


class DistributionSettingsApi(APIView):
    """
    GET  /api/settings/distribution/  — current value + who/when changed
    PATCH /api/settings/distribution/ — toggle, records audit-log entry

    Один endpoint покрывает оба тумблера (auto-distribution + morning-gate),
    т.к. оба живут в singleton `SystemSetting` и оба ограничены `IsManager`.
    """

    permission_classes = [IsManager]

    def get(self, request):
        obj = system_setting_get()
        return Response(DistributionSettingsSerializer(obj).data)

    def patch(self, request):
        ser = DistributionSettingsUpdateSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        obj = system_setting_update(
            user=request.user,
            auto_distribution_enabled=ser.validated_data.get("auto_distribution_enabled"),
            morning_gate_enabled=ser.validated_data.get("morning_gate_enabled"),
        )
        return Response(DistributionSettingsSerializer(obj).data)

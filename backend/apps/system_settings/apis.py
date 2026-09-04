"""
Thin DRF views для управления системными настройками.
Только менеджер может читать/менять.
"""

from __future__ import annotations

from django.core.exceptions import ValidationError as DjangoValidationError
from rest_framework import serializers, status
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.users.permissions import IsManager

from .selectors import get_retry_export_statuses, system_setting_get
from .services import retry_export_statuses_update, system_setting_update


class DistributionSettingsSerializer(serializers.Serializer):
    auto_distribution_enabled = serializers.BooleanField()
    morning_gate_enabled = serializers.BooleanField()
    morning_split_cap = serializers.IntegerField()
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
    # Все поля опциональны — фронт шлёт только тот параметр, что двигают.
    auto_distribution_enabled = serializers.BooleanField(required=False)
    morning_gate_enabled = serializers.BooleanField(required=False)
    morning_split_cap = serializers.IntegerField(required=False, min_value=0, max_value=1000)

    def validate(self, attrs):
        if not attrs:
            raise serializers.ValidationError(
                "передайте хотя бы одно поле: auto_distribution_enabled, "
                "morning_gate_enabled или morning_split_cap"
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
            morning_split_cap=ser.validated_data.get("morning_split_cap"),
        )
        return Response(DistributionSettingsSerializer(obj).data)


# ---- Retry-export statuses ------------------------------------------------


class _RetryExportStatusesUpdateSerializer(serializers.Serializer):
    """Список кодов LeadStatusLabel. Пустой → селектор возьмёт дефолт."""

    statuses = serializers.ListField(
        child=serializers.CharField(max_length=64, allow_blank=False),
        allow_empty=True,
    )


class RetryExportStatusesApi(APIView):
    """
    GET  /api/settings/retry-export/  → текущий выбор + все доступные
                                        LeadStatusLabel'ы (active).
    PATCH /api/settings/retry-export/ → сохранить новый список кодов.

    Manager-only (IsManager). Валидация «code существует» — в сервисе
    `retry_export_statuses_update`, чтобы Google Sheets export не падал
    молча при следующей выгрузке.
    """

    permission_classes = [IsManager]

    def get(self, request):
        # Локальный import — избегаем circular deps между apps на старте.
        from apps.leads.models import LeadStatusLabel

        codes = get_retry_export_statuses()
        available = list(
            LeadStatusLabel.objects.filter(is_active=True)
            .order_by("sort_order", "id")
            .values("code", "label_ru", "label_uz", "tone", "emoji")
        )
        return Response(
            {
                "statuses": codes,
                "available": available,
            }
        )

    def patch(self, request):
        ser = _RetryExportStatusesUpdateSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        try:
            obj = retry_export_statuses_update(
                user=request.user,
                statuses=ser.validated_data["statuses"],
            )
        except DjangoValidationError as exc:
            # `messages` — единый способ достать текст из ValidationError,
            # который может нести либо str, либо list, либо dict.
            detail = getattr(exc, "messages", None) or [str(exc)]
            return Response({"detail": detail}, status=status.HTTP_400_BAD_REQUEST)
        return Response(
            {
                "statuses": list(obj.retry_export_statuses or []),
            }
        )

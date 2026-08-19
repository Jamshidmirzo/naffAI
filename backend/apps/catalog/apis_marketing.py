"""
Marketing template + calculator + admin CRUD for InstallmentTier and
MarketingSettings.

Endpoints:
  GET  /api/catalog/phones/<id>/marketing/?lang=uz|ru
  POST /api/catalog/calculate/
  GET  /api/catalog/installment-tiers/
  POST /api/catalog/installment-tiers/          (manager)
  PATCH/DELETE /api/catalog/installment-tiers/<id>/  (manager)
  GET  /api/catalog/marketing-settings/
  PATCH /api/catalog/marketing-settings/        (manager)

Reads are open to any authenticated role — operators need the marketing
text and the calculator on their side of the app. Writes are manager-only
(historically `IsTeamLead`, but per business rule team_lead is hidden
from UI and manager is the effective admin — see `project_naffai_roles`).
"""

from __future__ import annotations

from rest_framework import serializers, status, viewsets
from rest_framework.generics import RetrieveUpdateAPIView
from rest_framework.permissions import BasePermission
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.common.exceptions import ApplicationError
from apps.users.permissions import IsAuthenticatedAnyRole, IsManager

from .models import InstallmentTier, MarketingSettings, PhoneModel
from .quote_builder import build_marketing_text
from .selectors import installment_tier_list
from .services import (
    calculate_installments,
    installment_tier_upsert,
    marketing_settings_update,
)


class WritesManager(BasePermission):
    """
    Read-only endpoints (GET/HEAD/OPTIONS) open to any authenticated role;
    writes to manager (senior). Matches the pattern used by
    `WritesTeamLead` in apis_phones but with the newer, business-correct
    role name.
    """

    def has_permission(self, request, view) -> bool:
        if request.method in ("GET", "HEAD", "OPTIONS"):
            return IsAuthenticatedAnyRole().has_permission(request, view)
        return IsManager().has_permission(request, view)


# ---------------------------------------------------------------------------
# Marketing text
# ---------------------------------------------------------------------------


class PhoneMarketingTextApi(APIView):
    """Return the ready-to-paste marketing block for a phone."""

    permission_classes = [IsAuthenticatedAnyRole]

    def get(self, request, phone_id: int):
        phone = PhoneModel.objects.filter(pk=phone_id).first()
        if phone is None:
            return Response({"detail": "not found"}, status=status.HTTP_404_NOT_FOUND)
        lang = request.query_params.get("lang", "uz")
        text = build_marketing_text(phone, language=lang)
        return Response({"text": text, "lang": lang, "phone_id": phone.id})


# ---------------------------------------------------------------------------
# Calculator
# ---------------------------------------------------------------------------


class CalculatorInputSerializer(serializers.Serializer):
    amount = serializers.CharField(required=False, allow_blank=True, default="0")
    down_payment = serializers.CharField(required=False, allow_blank=True, default="0")
    phone_id = serializers.IntegerField(required=False, allow_null=True)


class InstallmentCalculatorApi(APIView):
    permission_classes = [IsAuthenticatedAnyRole]

    def post(self, request):
        ser = CalculatorInputSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        data = ser.validated_data
        phone = None
        phone_id = data.get("phone_id")
        if phone_id:
            phone = PhoneModel.objects.filter(pk=phone_id).first()
        payload = calculate_installments(
            amount=data.get("amount") or "0",
            down_payment=data.get("down_payment") or "0",
            phone=phone,
        )
        if phone is not None:
            payload["phone"] = {
                "id": phone.id,
                "brand": phone.brand,
                "model_name": phone.model_name,
                "price": str(phone.price),
            }
        return Response(payload)


# ---------------------------------------------------------------------------
# InstallmentTier CRUD
# ---------------------------------------------------------------------------


class InstallmentTierSerializer(serializers.ModelSerializer):
    class Meta:
        model = InstallmentTier
        fields = [
            "id",
            "months",
            "commission_pct",
            "is_active",
            "show_in_marketing",
            "sort_order",
        ]


class InstallmentTierViewSet(viewsets.ModelViewSet):
    permission_classes = [WritesManager]
    serializer_class = InstallmentTierSerializer
    queryset = InstallmentTier.objects.all().order_by("sort_order", "months")

    def get_queryset(self):
        active_only = self.request.query_params.get("active_only") == "1"
        return installment_tier_list(active_only=active_only)

    def create(self, request, *args, **kwargs):
        ser = self.get_serializer(data=request.data)
        ser.is_valid(raise_exception=True)
        try:
            tier = installment_tier_upsert(
                user=request.user, **ser.validated_data
            )
        except ApplicationError as exc:
            return Response(
                {"detail": exc.message, **exc.extra},
                status=status.HTTP_400_BAD_REQUEST,
            )
        return Response(
            self.get_serializer(tier).data, status=status.HTTP_201_CREATED
        )

    def update(self, request, *args, **kwargs):
        instance = self.get_object()
        partial = kwargs.pop("partial", False)
        ser = self.get_serializer(instance, data=request.data, partial=partial)
        ser.is_valid(raise_exception=True)
        # `months` is unique — upsert always targets months from validated data,
        # falling back to the instance's current months on PATCH.
        vd = dict(ser.validated_data)
        vd.setdefault("months", instance.months)
        vd.setdefault("commission_pct", instance.commission_pct)
        vd.setdefault("is_active", instance.is_active)
        vd.setdefault("show_in_marketing", instance.show_in_marketing)
        vd.setdefault("sort_order", instance.sort_order)
        try:
            tier = installment_tier_upsert(user=request.user, **vd)
        except ApplicationError as exc:
            return Response(
                {"detail": exc.message, **exc.extra},
                status=status.HTTP_400_BAD_REQUEST,
            )
        return Response(self.get_serializer(tier).data)


# ---------------------------------------------------------------------------
# MarketingSettings — singleton get/patch
# ---------------------------------------------------------------------------


class MarketingSettingsSerializer(serializers.ModelSerializer):
    class Meta:
        model = MarketingSettings
        fields = [
            "id",
            "default_tagline",
            "phone_primary",
            "phone_secondary",
            "telegram_handle",
            "address",
            "benefits",
            "updated_at",
        ]
        read_only_fields = ["id", "updated_at"]


class MarketingSettingsApi(RetrieveUpdateAPIView):
    """
    Singleton — always operates on pk=1. GET is open to any authenticated
    role (marketing text builder reads it from anyone's session); PATCH
    is manager-only.
    """

    serializer_class = MarketingSettingsSerializer

    def get_permissions(self):
        if self.request.method in ("GET", "HEAD", "OPTIONS"):
            return [IsAuthenticatedAnyRole()]
        return [IsManager()]

    def get_object(self):
        return MarketingSettings.load()

    def perform_update(self, serializer):
        instance = marketing_settings_update(
            user=self.request.user, **serializer.validated_data
        )
        serializer.instance = instance

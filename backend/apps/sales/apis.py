import datetime as dt
from decimal import Decimal

from django.utils.dateparse import parse_datetime
from rest_framework import serializers, status
from rest_framework.generics import ListCreateAPIView, RetrieveUpdateDestroyAPIView
from rest_framework.parsers import FormParser, MultiPartParser
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.common.exceptions import ApplicationError
from apps.users.permissions import IsTeamLead, IsTeamLeadOrManagerReadOnly

from .imports.excel_importer import import_file
from .models import GiftItem, Sale, SaleOperator, SalePartner
from .selectors import sale_get, sale_list
from .services import (
    sale_confirm,
    sale_create,
    sale_full_update,
    sale_mark_returned,
    sale_partial_update,
    sale_soft_delete,
)


class GiftItemSerializer(serializers.ModelSerializer):
    class Meta:
        model = GiftItem
        fields = ["id", "name", "cost"]


class SaleOperatorLineSerializer(serializers.ModelSerializer):
    operator_name = serializers.CharField(source="operator.full_name", read_only=True)

    class Meta:
        model = SaleOperator
        fields = ["operator", "operator_name", "amount"]


class SalePartnerLineSerializer(serializers.ModelSerializer):
    partner_name = serializers.CharField(source="partner.name", read_only=True)

    class Meta:
        model = SalePartner
        fields = ["partner", "partner_name", "amount"]


class SaleSerializer(serializers.ModelSerializer):
    operator_name = serializers.CharField(source="operator.full_name", read_only=True)
    channel_name = serializers.CharField(source="channel.name", read_only=True)
    gifts = GiftItemSerializer(many=True, read_only=True)
    operator_lines = SaleOperatorLineSerializer(many=True, read_only=True)
    partner_lines = SalePartnerLineSerializer(many=True, read_only=True)

    class Meta:
        model = Sale
        fields = [
            "id",
            "imei",
            "phone_model",
            "operator",
            "operator_name",
            "channel",
            "channel_name",
            "amount",
            "client_name",
            "client_phone",
            "operator_lines",
            "partner_lines",
            "comment",
            "sold_at",
            "status",
            "is_returned",
            "returned_at",
            "return_reason",
            "is_deleted",
            "gifts",
            "created_at",
            "updated_at",
        ]
        read_only_fields = [
            "id",
            "operator_name",
            "channel_name",
            "gifts",
            "operator_lines",
            "partner_lines",
            "is_deleted",
            "is_returned",
            "returned_at",
            "return_reason",
            "created_at",
            "updated_at",
        ]


class SaleCreateInputSerializer(serializers.Serializer):
    imei = serializers.CharField(min_length=6, max_length=15)
    phone_model = serializers.CharField(max_length=128, required=False, allow_blank=True)
    # Multi-allocation (preferred): each line has {operator_id|operator_name, amount}
    operators = serializers.ListField(child=serializers.DictField(), required=False, default=list)
    partners = serializers.ListField(child=serializers.DictField(), required=False, default=list)
    # Legacy single-FK (back-compat)
    operator_id = serializers.IntegerField(required=False)
    channel_id = serializers.IntegerField(required=False)
    amount = serializers.DecimalField(
        max_digits=14,
        decimal_places=2,
        min_value=Decimal("1000"),
        max_value=Decimal("999999999999.99"),
        required=False,
    )
    client_name = serializers.CharField(max_length=128, required=False, allow_blank=True, default="")
    client_phone = serializers.CharField(max_length=32, required=False, allow_blank=True, default="")
    comment = serializers.CharField(required=False, allow_blank=True, default="")
    sold_at = serializers.DateTimeField(required=False)
    gifts = serializers.ListField(child=serializers.DictField(), required=False, default=list)
    allow_duplicate_imei = serializers.BooleanField(required=False, default=False)
    duplicate_override_comment = serializers.CharField(required=False, allow_blank=True, default="")

    def to_internal_value(self, data):
        if isinstance(data, dict):
            data = dict(data)
            if "operator" in data and "operator_id" not in data:
                data["operator_id"] = data.pop("operator")
            if "channel" in data and "channel_id" not in data:
                data["channel_id"] = data.pop("channel")
        return super().to_internal_value(data)


class SalePartialUpdateInputSerializer(serializers.Serializer):
    """
    Loose partial-update payload — used by `PATCH /sales/{id}/` for inline UI
    tweaks (date pencil, future client-info edits). Only whitelisted scalar
    fields are accepted; anything else is dropped by the service layer.
    """

    sold_at = serializers.DateTimeField(required=False)
    client_name = serializers.CharField(max_length=128, required=False, allow_blank=True)
    client_phone = serializers.CharField(max_length=32, required=False, allow_blank=True)
    comment = serializers.CharField(required=False, allow_blank=True)
    phone_model = serializers.CharField(max_length=128, required=False, allow_blank=True)


def _parse_dt(value: str | None) -> dt.datetime | None:
    if not value:
        return None
    return parse_datetime(value)


class SaleListCreateApi(ListCreateAPIView):
    permission_classes = [IsTeamLeadOrManagerReadOnly]
    serializer_class = SaleSerializer

    def get_queryset(self):
        params = self.request.query_params
        return sale_list(
            search=params.get("search"),
            operator_id=params.get("operator") or None,
            channel_id=params.get("channel") or None,
            date_from=_parse_dt(params.get("date_from")),
            date_to=_parse_dt(params.get("date_to")),
            status=params.get("status"),
            is_returned=(
                None
                if params.get("is_returned") is None
                else params.get("is_returned") in ("1", "true", "True")
            ),
        )

    def create(self, request, *args, **kwargs):
        input_ser = SaleCreateInputSerializer(data=request.data)
        input_ser.is_valid(raise_exception=True)
        try:
            sale = sale_create(user=request.user, **input_ser.validated_data)
        except ApplicationError as exc:
            return Response(
                {"detail": exc.message, **exc.extra}, status=status.HTTP_400_BAD_REQUEST
            )
        return Response(SaleSerializer(sale).data, status=status.HTTP_201_CREATED)


class SaleDetailApi(RetrieveUpdateDestroyAPIView):
    permission_classes = [IsTeamLead]
    serializer_class = SaleSerializer

    def get_queryset(self):
        return Sale.objects.select_related("operator", "channel").prefetch_related(
            "gifts", "operator_lines__operator", "partner_lines__partner"
        )

    def update(self, request, *args, **kwargs):
        """
        PUT  → full replace via `sale_full_update` (requires complete payload).
        PATCH → surgical update via `sale_partial_update` (only whitelisted
                scalar fields; preserves operator/partner lines, imei, amount).
        Both are exposed on the same URL so existing inline-edit callers
        (`PATCH /sales/{id}/` with just `sold_at`) keep working.
        """
        sale = self.get_object()
        partial = bool(kwargs.get("partial", False))

        if partial:
            input_ser = SalePartialUpdateInputSerializer(data=request.data)
            input_ser.is_valid(raise_exception=True)
            try:
                updated = sale_partial_update(
                    sale=sale, user=request.user, fields=input_ser.validated_data
                )
            except ApplicationError as exc:
                return Response(
                    {"detail": exc.message, **exc.extra}, status=status.HTTP_400_BAD_REQUEST
                )
            return Response(SaleSerializer(updated).data)

        input_ser = SaleCreateInputSerializer(data=request.data)
        input_ser.is_valid(raise_exception=True)
        try:
            updated = sale_full_update(sale=sale, user=request.user, **input_ser.validated_data)
        except ApplicationError as exc:
            return Response(
                {"detail": exc.message, **exc.extra}, status=status.HTTP_400_BAD_REQUEST
            )
        return Response(SaleSerializer(updated).data)

    def perform_destroy(self, instance):
        sale_soft_delete(sale=instance, user=self.request.user)


class SaleReturnApi(APIView):
    permission_classes = [IsTeamLead]

    def post(self, request, pk: int):
        sale = sale_get(pk)
        if not sale:
            return Response({"detail": "Not found"}, status=404)
        reason = (request.data or {}).get("reason", "")
        sale_mark_returned(sale=sale, reason=reason, user=request.user)
        return Response(SaleSerializer(sale).data)


class SaleConfirmApi(APIView):
    permission_classes = [IsTeamLead]

    def post(self, request, pk: int):
        sale = sale_get(pk)
        if not sale:
            return Response({"detail": "Not found"}, status=404)
        sale_confirm(sale=sale, user=request.user)
        return Response(SaleSerializer(sale).data)


class SaleImportExcelApi(APIView):
    permission_classes = [IsTeamLead]
    parser_classes = [MultiPartParser, FormParser]

    def post(self, request):
        upload = request.FILES.get("file")
        if not upload:
            return Response({"detail": "Прикрепите файл в поле 'file'"}, status=400)
        wipe = str(request.data.get("wipe", "0")).lower() in ("1", "true", "yes")
        try:
            result = import_file(
                upload, filename=getattr(upload, "name", ""), wipe_existing=wipe
            )
        except Exception as exc:  # noqa: BLE001 — surface parser errors to the UI
            return Response({"detail": f"Не удалось разобрать файл: {exc}"}, status=400)
        return Response(result.as_dict(), status=status.HTTP_200_OK)

import datetime as dt

from django.utils.dateparse import parse_datetime
from rest_framework import serializers, status
from rest_framework.generics import ListCreateAPIView, RetrieveUpdateDestroyAPIView
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.common.exceptions import ApplicationError
from apps.users.permissions import IsTeamLead, IsTeamLeadOrManagerReadOnly

from .models import GiftItem, Sale
from .selectors import sale_get, sale_list
from .services import sale_confirm, sale_create, sale_mark_returned, sale_soft_delete, sale_update


class GiftItemSerializer(serializers.ModelSerializer):
    class Meta:
        model = GiftItem
        fields = ["id", "name", "cost"]


class SaleSerializer(serializers.ModelSerializer):
    operator_name = serializers.CharField(source="operator.full_name", read_only=True)
    channel_name = serializers.CharField(source="channel.name", read_only=True)
    gifts = GiftItemSerializer(many=True, read_only=True)

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
            "is_deleted",
            "is_returned",
            "returned_at",
            "return_reason",
            "created_at",
            "updated_at",
        ]


class SaleCreateInputSerializer(serializers.Serializer):
    imei = serializers.CharField(max_length=15)
    phone_model = serializers.CharField(max_length=128, required=False, allow_blank=True)
    operator = serializers.IntegerField()
    channel = serializers.IntegerField()
    amount = serializers.DecimalField(max_digits=14, decimal_places=2)
    comment = serializers.CharField(required=False, allow_blank=True, default="")
    sold_at = serializers.DateTimeField(required=False)
    gifts = serializers.ListField(child=serializers.DictField(), required=False, default=list)
    allow_duplicate_imei = serializers.BooleanField(required=False, default=False)
    duplicate_override_comment = serializers.CharField(required=False, allow_blank=True, default="")


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
        return Sale.objects.select_related("operator", "channel").prefetch_related("gifts")

    def perform_update(self, serializer):
        instance = sale_update(
            sale=serializer.instance, user=self.request.user, **serializer.validated_data
        )
        serializer.instance = instance

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

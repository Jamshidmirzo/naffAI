"""
Thin DRF views for the lead domain.

Only parsing + dispatching to services/selectors happens here. Business
rules (alias resolution, phone normalization, auto-assignment) live in
`services.py`; queryset building lives in `selectors.py`.
"""

from __future__ import annotations

from django.utils.dateparse import parse_datetime
from rest_framework import serializers, status
from rest_framework.generics import ListCreateAPIView, RetrieveAPIView
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.common.exceptions import ApplicationError
from apps.common.validators import normalize_uz_phone
from apps.users.permissions import (
    IsAuthenticatedAnyRole,
    IsOperator,
    IsTeamLead,
    IsTeamLeadOrManagerReadOnly,
)

from .models import (
    Lead,
    LeadStatus,
    OperatorSheetAlias,
    SheetSource,
)
from .selectors import (
    lead_get,
    lead_list,
    leads_for_operator,
    operator_is_blocked_by_overdue_callbacks,
    telegram_link_for_phone,
)
from .services import (
    lead_convert_to_sale,
    lead_create,
    lead_reassign,
    lead_update_status,
    operator_alias_upsert,
    sheet_source_upsert,
    telegram_link_upsert,
)


# ---- Serializers ---------------------------------------------------------


class LeadSerializer(serializers.ModelSerializer):
    operator_name = serializers.CharField(source="operator.full_name", read_only=True)
    sheet_source_name = serializers.CharField(
        source="sheet_source.name", read_only=True, default=None
    )

    class Meta:
        model = Lead
        fields = [
            "id",
            "full_name",
            "phone",
            "phone_raw",
            "phone_invalid",
            "product_hint",
            "has_card",
            "status",
            "source",
            "operator",
            "operator_name",
            "needs_review",
            "sheet_source",
            "sheet_source_name",
            "sheet_row_index",
            "metadata",
            "created_at",
            "updated_at",
        ]
        read_only_fields = [
            "id",
            "phone_invalid",
            "operator_name",
            "sheet_source_name",
            "created_at",
            "updated_at",
        ]


class LeadCreateInputSerializer(serializers.Serializer):
    full_name = serializers.CharField(max_length=128, required=False, allow_blank=True)
    phone = serializers.CharField(max_length=64, required=False, allow_blank=True)
    product_hint = serializers.CharField(
        max_length=256, required=False, allow_blank=True
    )
    has_card = serializers.CharField(max_length=64, required=False, allow_blank=True)
    metadata = serializers.DictField(required=False)
    auto_assign = serializers.BooleanField(required=False, default=True)


class LeadReassignInputSerializer(serializers.Serializer):
    operator_id = serializers.IntegerField()
    reason = serializers.CharField(max_length=256, required=False, allow_blank=True)


class LeadStatusInputSerializer(serializers.Serializer):
    status = serializers.ChoiceField(choices=LeadStatus.choices)
    comment = serializers.CharField(required=False, allow_blank=True, default="")


class SheetSourceSerializer(serializers.ModelSerializer):
    class Meta:
        model = SheetSource
        fields = [
            "id",
            "name",
            "spreadsheet_id",
            "gid",
            "worksheet_name",
            "column_map",
            "default_status",
            "active",
            "last_synced_at",
            "last_synced_row",
        ]
        read_only_fields = ["id", "last_synced_at", "last_synced_row"]


class OperatorSheetAliasSerializer(serializers.ModelSerializer):
    operator_name = serializers.CharField(source="operator.full_name", read_only=True)

    class Meta:
        model = OperatorSheetAlias
        fields = ["id", "alias_name", "operator", "operator_name", "created_at", "updated_at"]
        read_only_fields = ["id", "operator_name", "created_at", "updated_at"]


class LeadConvertInputSerializer(serializers.Serializer):
    imei = serializers.CharField(min_length=6, max_length=15)
    phone_model = serializers.CharField(
        max_length=128, required=False, allow_blank=True
    )
    quantity = serializers.IntegerField(min_value=1, required=False, default=1)
    operators = serializers.ListField(
        child=serializers.DictField(), required=False, default=list
    )
    partners = serializers.ListField(
        child=serializers.DictField(), required=False, default=list
    )
    operator_id = serializers.IntegerField(required=False)
    channel_id = serializers.IntegerField(required=False)
    amount = serializers.DecimalField(
        max_digits=14, decimal_places=2, required=False
    )
    discount = serializers.DecimalField(
        max_digits=14, decimal_places=2, required=False
    )
    client_name = serializers.CharField(max_length=128, required=False, allow_blank=True)
    client_phone = serializers.CharField(max_length=32, required=False, allow_blank=True)
    comment = serializers.CharField(required=False, allow_blank=True, default="")
    sold_at = serializers.DateTimeField(required=False)
    gifts = serializers.ListField(
        child=serializers.DictField(), required=False, default=list
    )
    allow_duplicate_imei = serializers.BooleanField(required=False, default=False)
    duplicate_override_comment = serializers.CharField(
        required=False, allow_blank=True, default=""
    )


# ---- helpers -------------------------------------------------------------


def _operator_for_request(request) -> int | None:
    profile = getattr(request.user, "profile", None)
    return profile.operator_id if profile else None


# ---- Views ---------------------------------------------------------------


class LeadListCreateApi(ListCreateAPIView):
    permission_classes = [IsTeamLeadOrManagerReadOnly]
    serializer_class = LeadSerializer

    def get_queryset(self):
        qp = self.request.query_params
        return lead_list(
            status=qp.get("status") or None,
            operator_id=int(qp["operator"]) if qp.get("operator") else None,
            source=qp.get("source") or None,
            needs_review=(
                qp.get("needs_review") in ("1", "true", "True")
                if qp.get("needs_review") is not None
                else None
            ),
            phone_invalid=(
                qp.get("phone_invalid") in ("1", "true", "True")
                if qp.get("phone_invalid") is not None
                else None
            ),
            search=qp.get("search") or None,
        )

    def create(self, request, *args, **kwargs):
        input_ser = LeadCreateInputSerializer(data=request.data)
        input_ser.is_valid(raise_exception=True)
        try:
            lead = lead_create(user=request.user, **input_ser.validated_data)
        except ApplicationError as exc:
            return Response({"detail": exc.message, **exc.extra}, status=400)
        return Response(LeadSerializer(lead).data, status=status.HTTP_201_CREATED)


class LeadDetailApi(RetrieveAPIView):
    permission_classes = [IsTeamLeadOrManagerReadOnly]
    serializer_class = LeadSerializer

    def get_queryset(self):
        return Lead.objects.select_related("operator", "sheet_source")


class LeadMyListApi(APIView):
    """
    Operator workstation — leads currently assigned to me.
    Returns a small envelope with the operator-blocked banner state so the
    frontend doesn't need a second call.
    """

    permission_classes = [IsOperator]

    def get(self, request):
        op_id = _operator_for_request(request)
        if not op_id:
            return Response({"detail": "У пользователя не привязан оператор"}, status=400)

        from apps.operators.models import Operator

        operator = Operator.objects.filter(pk=op_id).first()
        if not operator:
            return Response({"detail": "Оператор не найден"}, status=404)

        include_archived = request.query_params.get("include_archived") in ("1", "true")
        qs = leads_for_operator(operator, include_archived=include_archived)
        return Response(
            {
                "operator": {
                    "id": operator.id,
                    "full_name": operator.full_name,
                    "status": operator.status,
                    "blocked": operator_is_blocked_by_overdue_callbacks(operator),
                },
                "results": LeadSerializer(qs, many=True).data,
            }
        )


class LeadReassignApi(APIView):
    permission_classes = [IsTeamLead]

    def post(self, request, pk: int):
        lead = lead_get(pk)
        if not lead:
            return Response({"detail": "Не найден"}, status=404)
        ser = LeadReassignInputSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        from apps.operators.models import Operator

        op = Operator.objects.filter(pk=ser.validated_data["operator_id"]).first()
        if not op:
            return Response({"detail": "Оператор не найден"}, status=400)
        try:
            lead_reassign(
                lead=lead,
                new_operator=op,
                user=request.user,
                reason=ser.validated_data.get("reason", ""),
            )
        except ApplicationError as exc:
            return Response({"detail": exc.message, **exc.extra}, status=400)
        return Response(LeadSerializer(lead).data)


class LeadStatusApi(APIView):
    permission_classes = [IsAuthenticatedAnyRole]

    def post(self, request, pk: int):
        lead = lead_get(pk)
        if not lead:
            return Response({"detail": "Не найден"}, status=404)
        ser = LeadStatusInputSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        try:
            lead_update_status(
                lead=lead,
                status=ser.validated_data["status"],
                user=request.user,
                comment=ser.validated_data.get("comment", ""),
            )
        except ApplicationError as exc:
            return Response({"detail": exc.message, **exc.extra}, status=400)
        return Response(LeadSerializer(lead).data)


class LeadConvertToSaleApi(APIView):
    permission_classes = [IsAuthenticatedAnyRole]

    def post(self, request, pk: int):
        lead = lead_get(pk)
        if not lead:
            return Response({"detail": "Не найден"}, status=404)
        ser = LeadConvertInputSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        try:
            sale = lead_convert_to_sale(
                lead=lead, user=request.user, sale_data=dict(ser.validated_data)
            )
        except ApplicationError as exc:
            return Response({"detail": exc.message, **exc.extra}, status=400)
        return Response(
            {"lead_id": lead.id, "sale_id": sale.id, "status": lead.status},
            status=status.HTTP_201_CREATED,
        )


# ---- Sheet configuration CRUD -------------------------------------------


class SheetSourceListCreateApi(ListCreateAPIView):
    permission_classes = [IsTeamLead]
    serializer_class = SheetSourceSerializer

    def get_queryset(self):
        return SheetSource.objects.all().order_by("name")

    def create(self, request, *args, **kwargs):
        ser = self.get_serializer(data=request.data)
        ser.is_valid(raise_exception=True)
        data = ser.validated_data
        obj = sheet_source_upsert(
            name=data["name"],
            spreadsheet_id=data["spreadsheet_id"],
            gid=int(data["gid"]),
            column_map=data.get("column_map") or {},
            default_status=data.get("default_status") or LeadStatus.NEW,
            worksheet_name=data.get("worksheet_name") or "",
            active=data.get("active", True),
            user=request.user,
        )
        return Response(
            SheetSourceSerializer(obj).data, status=status.HTTP_201_CREATED
        )


class SheetSourceDetailApi(APIView):
    permission_classes = [IsTeamLead]

    def get(self, request, pk: int):
        obj = SheetSource.objects.filter(pk=pk).first()
        if not obj:
            return Response({"detail": "Not found"}, status=404)
        return Response(SheetSourceSerializer(obj).data)

    def patch(self, request, pk: int):
        obj = SheetSource.objects.filter(pk=pk).first()
        if not obj:
            return Response({"detail": "Not found"}, status=404)
        ser = SheetSourceSerializer(obj, data=request.data, partial=True)
        ser.is_valid(raise_exception=True)
        data = ser.validated_data
        updated = sheet_source_upsert(
            name=data.get("name", obj.name),
            spreadsheet_id=data.get("spreadsheet_id", obj.spreadsheet_id),
            gid=int(data.get("gid", obj.gid)),
            column_map=data.get("column_map", obj.column_map),
            default_status=data.get("default_status", obj.default_status),
            worksheet_name=data.get("worksheet_name", obj.worksheet_name),
            active=data.get("active", obj.active),
            user=request.user,
        )
        return Response(SheetSourceSerializer(updated).data)


class OperatorSheetAliasListCreateApi(ListCreateAPIView):
    permission_classes = [IsTeamLead]
    serializer_class = OperatorSheetAliasSerializer

    def get_queryset(self):
        return OperatorSheetAlias.objects.select_related("operator").all()

    def create(self, request, *args, **kwargs):
        ser = self.get_serializer(data=request.data)
        ser.is_valid(raise_exception=True)
        data = ser.validated_data
        from apps.operators.models import Operator

        op = None
        if data.get("operator"):
            op = Operator.objects.filter(pk=data["operator"].id if hasattr(data["operator"], "id") else data["operator"]).first()
        try:
            obj = operator_alias_upsert(
                alias_name=data["alias_name"],
                operator=op,
                user=request.user,
            )
        except ApplicationError as exc:
            return Response({"detail": exc.message, **exc.extra}, status=400)
        return Response(
            OperatorSheetAliasSerializer(obj).data, status=status.HTTP_201_CREATED
        )


class OperatorSheetAliasDetailApi(APIView):
    permission_classes = [IsTeamLead]

    def patch(self, request, pk: int):
        obj = OperatorSheetAlias.objects.filter(pk=pk).first()
        if not obj:
            return Response({"detail": "Not found"}, status=404)
        op = obj.operator
        if "operator" in request.data:
            from apps.operators.models import Operator

            op = (
                Operator.objects.filter(pk=request.data["operator"]).first()
                if request.data["operator"]
                else None
            )
        try:
            updated = operator_alias_upsert(
                alias_name=request.data.get("alias_name", obj.alias_name),
                operator=op,
                user=request.user,
            )
        except ApplicationError as exc:
            return Response({"detail": exc.message, **exc.extra}, status=400)
        return Response(OperatorSheetAliasSerializer(updated).data)

    def delete(self, request, pk: int):
        obj = OperatorSheetAlias.objects.filter(pk=pk).first()
        if not obj:
            return Response(status=204)
        obj.delete()
        return Response(status=204)


# ---- Telegram link cache ------------------------------------------------


class TelegramLookupApi(APIView):
    """
    GET /api/telegram/lookup?phone=+998... — used by the "Написать в TG"
    button on the operator workstation. Frontend prefers
    `https://t.me/{username}`; falls back to `tg://resolve?phone=…`.
    """

    permission_classes = [IsAuthenticatedAnyRole]

    def get(self, request):
        raw = request.query_params.get("phone", "")
        normalized, valid = normalize_uz_phone(raw)
        if not valid:
            return Response({"detail": "Некорректный телефон"}, status=400)
        link = telegram_link_for_phone(normalized)
        if not link or not link.username:
            return Response(
                {"phone": normalized, "username": None, "fallback": True}, status=404
            )
        return Response(
            {
                "phone": normalized,
                "username": link.username,
                "verified_at": link.verified_at.isoformat() if link.verified_at else None,
                "fallback": False,
            }
        )

    def post(self, request):
        """Manual upsert (team lead / bot). Body: {phone, username}."""
        raw = request.data.get("phone", "")
        username = request.data.get("username", "")
        link = telegram_link_upsert(phone=raw, username=username)
        if link is None:
            return Response({"detail": "Некорректный телефон"}, status=400)
        return Response({"phone": link.phone, "username": link.username})


# ---- Parse helper -------------------------------------------------------


def _parse_dt(value):
    return parse_datetime(value) if value else None

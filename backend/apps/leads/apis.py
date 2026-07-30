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
from apps.operators.selectors import operator_get
from apps.users.permissions import (
    IsAuthenticatedAnyRole,
    IsOperator,
    IsTeamLead,
    IsTeamLeadOrManagerReadOnly,
)

from .models import (
    DistributionMode,
    Lead,
    LeadStatus,
    LeadStatusLabel,
    OperatorSheetAlias,
    SheetSource,
)
from .selectors import (
    lead_get,
    lead_list,
    leads_for_operator,
    operator_has_open_callbacks,
    operator_is_blocked_by_overdue_callbacks,
    operator_open_callbacks_count,
    telegram_link_for_phone,
)
from .services import (
    lead_convert_to_sale,
    lead_create,
    lead_postpone,
    lead_reassign,
    lead_unpostpone,
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
    postponed_by_name = serializers.CharField(
        source="postponed_by.full_name", read_only=True, default=None
    )
    previous_operator_name = serializers.SerializerMethodField()
    is_retry = serializers.SerializerMethodField()

    def get_previous_operator_name(self, lead: Lead) -> str:
        prev = (
            lead.assignments.exclude(operator_id=lead.operator_id)
            .order_by("-created_at")
            .select_related("operator")
            .first()
        )
        return prev.operator.full_name if prev else ""

    def get_is_retry(self, lead: Lead) -> bool:
        from .models import LeadAssignmentSource

        return lead.assignments.filter(
            source=LeadAssignmentSource.QIMMATLIK_RETRY
        ).exists()

    class Meta:
        model = Lead
        fields = [
            "id",
            "full_name",
            "phone",
            "phone_alt",
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
            "postponed_at",
            "postponed_by",
            "postponed_by_name",
            "postpone_reason",
            "previous_operator_name",
            "is_retry",
            "created_at",
            "updated_at",
        ]
        read_only_fields = [
            "id",
            "phone_invalid",
            "operator_name",
            "sheet_source_name",
            "postponed_at",
            "postponed_by",
            "postponed_by_name",
            "postpone_reason",
            "previous_operator_name",
            "is_retry",
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
    # Accepts any string — real validation happens in `lead_update_status`,
    # which cross-references LeadStatusLabel so custom manager-created
    # statuses are accepted alongside the builtin enum.
    status = serializers.CharField(max_length=64)
    comment = serializers.CharField(required=False, allow_blank=True, default="")


class SheetSourceSerializer(serializers.ModelSerializer):
    default_operator_name = serializers.CharField(
        source="default_operator.full_name", read_only=True, default=None
    )

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
            "default_operator",
            "default_operator_name",
            "distribution_mode",
            "writeback_columns",
        ]
        read_only_fields = [
            "id",
            "last_synced_at",
            "last_synced_row",
            "default_operator_name",
        ]


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
    bonus_note = serializers.CharField(required=False, allow_blank=True, default="")
    sheet_source_id = serializers.IntegerField(required=False, allow_null=True)


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
            sheet_source_id=int(qp["sheet_source"]) if qp.get("sheet_source") else None,
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

        operator = operator_get(op_id)
        if not operator:
            return Response({"detail": "Оператор не найден"}, status=404)

        include_archived = request.query_params.get("include_archived") in ("1", "true")
        view = request.query_params.get("view", "active")
        if view not in ("active", "postponed", "all"):
            return Response(
                {"detail": "view must be one of: active, postponed, all"}, status=400
            )

        qs = leads_for_operator(
            operator, include_archived=include_archived, view=view
        )
        active_count = leads_for_operator(
            operator, include_archived=include_archived, view="active"
        ).count()
        postponed_count = leads_for_operator(
            operator, include_archived=include_archived, view="postponed"
        ).count()

        open_cb_count = operator_open_callbacks_count(operator)
        return Response(
            {
                "operator": {
                    "id": operator.id,
                    "full_name": operator.full_name,
                    "status": operator.status,
                    "blocked": operator_has_open_callbacks(operator),
                    "overdue_blocked": operator_is_blocked_by_overdue_callbacks(
                        operator
                    ),
                    "open_callbacks": open_cb_count,
                },
                "counts": {"active": active_count, "postponed": postponed_count},
                "results": LeadSerializer(qs, many=True).data,
            }
        )


class LeadPostponeInputSerializer(serializers.Serializer):
    reason = serializers.CharField(max_length=280, required=False, allow_blank=True, default="")


class LeadPostponeApi(APIView):
    """Operator postpones one of their own leads to the 'later' bucket."""

    permission_classes = [IsOperator]

    def post(self, request, pk: int):
        op_id = _operator_for_request(request)
        if not op_id:
            return Response({"detail": "У пользователя не привязан оператор"}, status=400)
        operator = operator_get(op_id)
        if not operator:
            return Response({"detail": "Оператор не найден"}, status=404)

        lead = lead_get(pk)
        if not lead:
            return Response({"detail": "Лид не найден"}, status=404)
        if lead.operator_id != operator.id:
            return Response({"detail": "Можно откладывать только свои лиды"}, status=403)

        ser = LeadPostponeInputSerializer(data=request.data)
        ser.is_valid(raise_exception=True)

        try:
            lead = lead_postpone(
                lead=lead,
                operator=operator,
                reason=ser.validated_data.get("reason", ""),
                user=request.user,
            )
        except ApplicationError as exc:
            return Response({"detail": str(exc)}, status=400)

        return Response(LeadSerializer(lead).data)


class LeadUnpostponeApi(APIView):
    """Operator returns a postponed lead back to the active queue."""

    permission_classes = [IsOperator]

    def post(self, request, pk: int):
        op_id = _operator_for_request(request)
        if not op_id:
            return Response({"detail": "У пользователя не привязан оператор"}, status=400)
        operator = operator_get(op_id)
        if not operator:
            return Response({"detail": "Оператор не найден"}, status=404)

        lead = lead_get(pk)
        if not lead:
            return Response({"detail": "Лид не найден"}, status=404)
        if lead.operator_id != operator.id:
            return Response({"detail": "Можно возвращать только свои лиды"}, status=403)

        try:
            lead = lead_unpostpone(lead=lead, operator=operator, user=request.user)
        except ApplicationError as exc:
            return Response({"detail": str(exc)}, status=400)

        return Response(LeadSerializer(lead).data)


class LeadReassignApi(APIView):
    permission_classes = [IsTeamLead]

    def post(self, request, pk: int):
        lead = lead_get(pk)
        if not lead:
            return Response({"detail": "Не найден"}, status=404)
        ser = LeadReassignInputSerializer(data=request.data)
        ser.is_valid(raise_exception=True)

        op = operator_get(ser.validated_data["operator_id"])
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
        default_op = data.get("default_operator")
        obj = sheet_source_upsert(
            name=data["name"],
            spreadsheet_id=data["spreadsheet_id"],
            gid=int(data["gid"]),
            column_map=data.get("column_map") or {},
            default_status=data.get("default_status") or LeadStatus.NEW,
            worksheet_name=data.get("worksheet_name") or "",
            active=data.get("active", True),
            default_operator=default_op if default_op else None,
            distribution_mode=data.get("distribution_mode") or DistributionMode.ALIAS_ONLY,
            writeback_columns=data.get("writeback_columns"),
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
        default_op = data.get("default_operator", obj.default_operator)
        updated = sheet_source_upsert(
            name=data.get("name", obj.name),
            spreadsheet_id=data.get("spreadsheet_id", obj.spreadsheet_id),
            gid=int(data.get("gid", obj.gid)),
            column_map=data.get("column_map", obj.column_map),
            default_status=data.get("default_status", obj.default_status),
            worksheet_name=data.get("worksheet_name", obj.worksheet_name),
            active=data.get("active", obj.active),
            default_operator=default_op if default_op else None,
            distribution_mode=data.get("distribution_mode", obj.distribution_mode),
            writeback_columns=data.get("writeback_columns", obj.writeback_columns),
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
        op = None
        if data.get("operator"):
            op_id = data["operator"].id if hasattr(data["operator"], "id") else data["operator"]
            op = operator_get(op_id)
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
            op = operator_get(request.data["operator"]) if request.data["operator"] else None
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


# ---- LeadStatusLabel CRUD ----------------------------------------------

import re as _re


class LeadStatusLabelSerializer(serializers.ModelSerializer):
    class Meta:
        model = LeadStatusLabel
        fields = [
            "id",
            "code",
            "label_ru",
            "label_uz",
            "tone",
            "emoji",
            "sort_order",
            "show_in_chip",
            "show_in_button",
            "is_active",
            "is_builtin",
            "created_at",
            "updated_at",
        ]
        read_only_fields = ["id", "is_builtin", "created_at", "updated_at"]


_CODE_RE = _re.compile(r"^[a-z][a-z0-9_]{1,63}$")


class LeadStatusLabelListCreateApi(APIView):
    """GET: any authenticated. POST: senior only."""

    def get_permissions(self):
        from rest_framework.permissions import IsAuthenticated

        if self.request.method == "POST":
            return [IsTeamLead()]
        return [IsAuthenticated()]

    def get(self, request):
        qs = LeadStatusLabel.objects.all().order_by("sort_order", "id")
        return Response(LeadStatusLabelSerializer(qs, many=True).data)

    def post(self, request):
        data = dict(request.data)
        code = (data.get("code") or "").strip().lower()
        if not _CODE_RE.match(code):
            return Response(
                {"detail": "code: только a-z, 0-9 и _; 2–64 символа, начинается с буквы"},
                status=400,
            )
        if LeadStatusLabel.objects.filter(code=code).exists():
            return Response({"detail": "Такой code уже существует"}, status=400)
        obj = LeadStatusLabel.objects.create(
            code=code,
            label_ru=(data.get("label_ru") or "").strip()[:80] or code,
            label_uz=(data.get("label_uz") or "").strip()[:80],
            tone=(data.get("tone") or "neutral")[:16],
            emoji=(data.get("emoji") or "")[:8],
            sort_order=int(data.get("sort_order") or 100),
            show_in_chip=bool(data.get("show_in_chip", True)),
            show_in_button=bool(data.get("show_in_button", True)),
            is_active=bool(data.get("is_active", True)),
            is_builtin=False,
            created_by=request.user if request.user.is_authenticated else None,
        )
        return Response(LeadStatusLabelSerializer(obj).data, status=201)


class LeadStatusLabelDetailApi(APIView):
    permission_classes = [IsTeamLead]

    def patch(self, request, pk: int):
        obj = LeadStatusLabel.objects.filter(pk=pk).first()
        if not obj:
            return Response({"detail": "Not found"}, status=404)
        # `code` is immutable for everyone; `is_builtin` cannot flip.
        for field in [
            "label_ru",
            "label_uz",
            "tone",
            "emoji",
            "sort_order",
            "show_in_chip",
            "show_in_button",
            "is_active",
        ]:
            if field in request.data:
                setattr(obj, field, request.data[field])
        obj.save()
        return Response(LeadStatusLabelSerializer(obj).data)

    def delete(self, request, pk: int):
        obj = LeadStatusLabel.objects.filter(pk=pk).first()
        if not obj:
            return Response(status=204)
        if obj.is_builtin:
            return Response(
                {"detail": "Встроенный статус нельзя удалить — можно только скрыть (is_active=false)"},
                status=400,
            )
        if Lead.objects.filter(status=obj.code).exists():
            return Response(
                {"detail": "Есть лиды с этим статусом. Сначала переведите их в другой статус."},
                status=400,
            )
        obj.delete()
        return Response(status=204)


# ---- Parse helper -------------------------------------------------------


def _parse_dt(value):
    return parse_datetime(value) if value else None

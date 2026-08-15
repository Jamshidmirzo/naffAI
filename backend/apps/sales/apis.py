import datetime as dt
from decimal import Decimal

from django.db.models import F
from django.utils.dateparse import parse_datetime
from rest_framework import serializers, status
from rest_framework.generics import ListCreateAPIView, RetrieveUpdateDestroyAPIView
from rest_framework.parsers import FormParser, JSONParser, MultiPartParser
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.common.exceptions import ApplicationError
from apps.users.permissions import (
    IsAuthenticatedAnyRole,
    IsTeamLead,
    IsTeamLeadOrManagerReadOnly,
)

from .imports.excel_importer import import_file
from .models import GiftItem, Sale, SaleOperator, SalePartner, SaleStatus
from .selectors import sale_get, sale_list
from .services import (
    sale_confirm,
    sale_create,
    sale_full_update,
    sale_mark_returned,
    sale_partial_update,
    sale_reject,
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
    sheet_source_name = serializers.CharField(
        source="sheet_source.name", read_only=True, default=None
    )
    gifts = GiftItemSerializer(many=True, read_only=True)
    operator_lines = SaleOperatorLineSerializer(many=True, read_only=True)
    partner_lines = SalePartnerLineSerializer(many=True, read_only=True)
    # NET amount (`amount − discount`) — derived on read so clients don't
    # have to recompute it. Both the SaleListCreateApi queryset and the
    # detail queryset annotate `total_price`, but we fall back to a
    # Python compute for safety (e.g. after a fresh `sale_create`).
    total_price = serializers.SerializerMethodField()

    class Meta:
        model = Sale
        fields = [
            "id",
            "imei",
            "phone_model",
            "quantity",
            "operator",
            "operator_name",
            "channel",
            "channel_name",
            "amount",
            "discount",
            "total_price",
            "client_name",
            "client_phone",
            "operator_lines",
            "partner_lines",
            "comment",
            "bonus_note",
            "sheet_source",
            "sheet_source_name",
            "sold_at",
            "status",
            "is_returned",
            "returned_at",
            "return_reason",
            "is_deleted",
            "gifts",
            "contract_photo",
            "rejection_reason",
            "rejected_at",
            "created_at",
            "updated_at",
        ]
        read_only_fields = [
            "id",
            "operator_name",
            "channel_name",
            "sheet_source_name",
            "gifts",
            "operator_lines",
            "partner_lines",
            "total_price",
            "is_deleted",
            "is_returned",
            "returned_at",
            "return_reason",
            "contract_photo",
            "rejection_reason",
            "rejected_at",
            "created_at",
            "updated_at",
        ]

    def get_total_price(self, obj) -> str:
        annotated = getattr(obj, "total_price", None)
        if annotated is not None:
            return str(annotated)
        return str((obj.amount or Decimal("0")) - (obj.discount or Decimal("0")))


class SaleCreateInputSerializer(serializers.Serializer):
    imei = serializers.CharField(min_length=6, max_length=15)
    phone_model = serializers.CharField(max_length=128, required=False, allow_blank=True)
    quantity = serializers.IntegerField(
        min_value=1, max_value=32767, required=False, default=1
    )
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
    discount = serializers.DecimalField(
        max_digits=14,
        decimal_places=2,
        min_value=Decimal("0"),
        max_value=Decimal("999999999999.99"),
        required=False,
        default=Decimal("0"),
    )
    client_name = serializers.CharField(max_length=128, required=False, allow_blank=True, default="")
    client_phone = serializers.CharField(max_length=32, required=False, allow_blank=True, default="")
    comment = serializers.CharField(required=False, allow_blank=True, default="")
    sold_at = serializers.DateTimeField(required=False)
    gifts = serializers.ListField(child=serializers.DictField(), required=False, default=list)
    allow_duplicate_imei = serializers.BooleanField(required=False, default=False)
    duplicate_override_comment = serializers.CharField(required=False, allow_blank=True, default="")
    bonus_note = serializers.CharField(required=False, allow_blank=True, default="")
    sheet_source_id = serializers.IntegerField(required=False, allow_null=True)
    # Optional — when the operator matched a lead by client_phone in the
    # SaleCreate form, we pass its id so the backend links sale.lead and
    # (unless the lead is already in a terminal status) flips it to WON.
    lead_id = serializers.IntegerField(required=False, allow_null=True)
    # Explicit status — usually server-forced (operator→pending, manager→
    # confirmed by default), but manager can pass "pending" too if they
    # want to review before publishing.
    status = serializers.ChoiceField(
        choices=[SaleStatus.PENDING, SaleStatus.CONFIRMED],
        required=False,
    )
    # Attached contract photo (multipart upload). Required by service layer
    # when status=pending; otherwise optional.
    contract_photo = serializers.ImageField(required=False, allow_null=True)

    def to_internal_value(self, data):
        # NB: `request.data` for multipart requests is a `QueryDict`, which
        # subclasses `dict`. Plain `dict(query_dict)` returns *lists* of
        # values per key (QueryDict's internal storage) — that used to
        # translate every scalar field to `["490154203237518"]` and every
        # file to `[<InMemoryUploadedFile>]`, causing DRF to reject every
        # field with "Not a valid string." / "Загруженный файл не является
        # корректным файлом." The `.dict()` method flattens each key to
        # its last value while preserving UploadedFile entries, so it's
        # the right unwrap for both `QueryDict` (multipart/form-encoded)
        # and plain `dict` (JSON) payloads.
        #
        # Regression traceable to the very first fix commit — the JSON
        # code path masked it because `dict({...})` is idempotent. Only
        # exposed once the OperatorSaleCreate form started sending
        # multipart FormData with the contract photo.
        if isinstance(data, dict):
            if hasattr(data, "dict"):
                data = data.dict()
            else:
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
    quantity = serializers.IntegerField(min_value=1, max_value=32767, required=False)
    # Inline discount edit — proportionally reduces operator credit on save.
    # See `apps.sales.services.sale_partial_update` for the audit/realloc flow.
    discount = serializers.DecimalField(
        max_digits=14,
        decimal_places=2,
        min_value=Decimal("0"),
        max_value=Decimal("999999999999.99"),
        required=False,
    )


def _parse_dt(value: str | None) -> dt.datetime | None:
    if not value:
        return None
    # Accept either an ISO datetime (existing callers) or a plain date
    # like "2026-06-01" coming from the <input type="date"> on the
    # filters panel. parse_datetime returns None for bare dates, in
    # which case fall back to parse_date and synthesize a datetime at
    # 00:00 in the active timezone.
    parsed = parse_datetime(value)
    if parsed:
        return parsed
    from django.utils import timezone
    from django.utils.dateparse import parse_date

    d = parse_date(value)
    if not d:
        return None
    return timezone.make_aware(dt.datetime.combine(d, dt.time.min))


def _parse_dt_inclusive_end(value: str | None) -> dt.datetime | None:
    """Like `_parse_dt` but if the input is a bare date, snap to end-of-day
    so `date_to=2026-06-01` includes every sale that happened on that day."""
    if not value:
        return None
    parsed = parse_datetime(value)
    if parsed:
        return parsed
    from django.utils import timezone
    from django.utils.dateparse import parse_date

    d = parse_date(value)
    if not d:
        return None
    return timezone.make_aware(dt.datetime.combine(d, dt.time.max))


class SaleListFilterSerializer(serializers.Serializer):
    """
    Whitelist + type-cast of the Sales list query params. Used only to
    validate the inbound `request.query_params` — the view still hands
    the parsed values straight to the `sale_list` selector.
    """

    search = serializers.CharField(required=False, allow_blank=True)
    # Legacy single-FK params (kept for back-compat with the Excel export
    # and any saved URLs that pre-date the multi-select UI).
    operator = serializers.IntegerField(required=False)
    channel = serializers.IntegerField(required=False)
    # New multi-select params used by the filters panel.
    operator_ids = serializers.ListField(
        child=serializers.IntegerField(), required=False
    )
    partner_ids = serializers.ListField(
        child=serializers.IntegerField(), required=False
    )
    date_from = serializers.CharField(required=False, allow_blank=True)
    date_to = serializers.CharField(required=False, allow_blank=True)
    status = serializers.ChoiceField(
        choices=["pending", "confirmed"], required=False
    )
    is_returned = serializers.BooleanField(required=False)


class SaleListCreateApi(ListCreateAPIView):
    # GET: managers only (through IsTeamLeadOrManagerReadOnly, i.e. seniors
    # RO + team_lead full). POST: any authenticated app-user — operators
    # can submit their own sales but the create() method below forces
    # status=pending and requires a contract_photo for them.
    permission_classes = [IsAuthenticatedAnyRole]
    parser_classes = [MultiPartParser, FormParser, JSONParser]
    serializer_class = SaleSerializer

    def get_permissions(self):
        # Read side (GET) still restricted to managers/team_lead.
        if self.request.method == "GET":
            return [IsTeamLeadOrManagerReadOnly()]
        return [IsAuthenticatedAnyRole()]

    def get_queryset(self):
        # DRF's `request.query_params` is a QueryDict — `getlist` is the
        # right call for repeating keys like `?partner_ids=1&partner_ids=2`.
        qp = self.request.query_params
        filter_data = {
            "search": qp.get("search") or "",
            "date_from": qp.get("date_from") or "",
            "date_to": qp.get("date_to") or "",
        }
        if qp.get("operator"):
            filter_data["operator"] = qp.get("operator")
        if qp.get("channel"):
            filter_data["channel"] = qp.get("channel")
        if qp.getlist("operator_ids"):
            filter_data["operator_ids"] = qp.getlist("operator_ids")
        if qp.getlist("partner_ids"):
            filter_data["partner_ids"] = qp.getlist("partner_ids")
        if qp.get("status"):
            filter_data["status"] = qp.get("status")
        if qp.get("is_returned") is not None and qp.get("is_returned") != "":
            filter_data["is_returned"] = qp.get("is_returned")

        ser = SaleListFilterSerializer(data=filter_data)
        ser.is_valid(raise_exception=True)
        v = ser.validated_data
        return sale_list(
            search=v.get("search") or None,
            operator_id=v.get("operator"),
            channel_id=v.get("channel"),
            operator_ids=v.get("operator_ids") or None,
            partner_ids=v.get("partner_ids") or None,
            date_from=_parse_dt(v.get("date_from") or None),
            date_to=_parse_dt_inclusive_end(v.get("date_to") or None),
            status=v.get("status"),
            is_returned=v.get("is_returned"),
        ).annotate(total_price=F("amount") - F("discount"))

    def create(self, request, *args, **kwargs):
        input_ser = SaleCreateInputSerializer(data=request.data)
        input_ser.is_valid(raise_exception=True)
        payload = dict(input_ser.validated_data)

        # Role gate: operators can only submit pending sales, and always
        # as the sole seller (their own operator record). Managers/team_leads
        # keep full control (default status=confirmed, arbitrary allocations).
        profile = getattr(request.user, "profile", None)
        role = getattr(profile, "role", None)
        if role == "operator":
            payload["status"] = SaleStatus.PENDING
            # Force self-allocation: single-op line = the operator's own id.
            op_id = getattr(profile, "operator_id", None)
            if not op_id:
                return Response(
                    {"detail": "У пользователя не привязан оператор"},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            payload["operator_id"] = op_id
            payload["operators"] = []  # no multi-allocation for operators

        try:
            sale = sale_create(user=request.user, **payload)
        except ApplicationError as exc:
            return Response(
                {"detail": exc.message, **exc.extra}, status=status.HTTP_400_BAD_REQUEST
            )
        return Response(SaleSerializer(sale).data, status=status.HTTP_201_CREATED)


class SaleDetailApi(RetrieveUpdateDestroyAPIView):
    # GET: any authenticated app-user (operators see only sales they created,
    # enforced in get_queryset below). PATCH/PUT/DELETE: managers only —
    # guarded in update()/perform_destroy() via _guard_writes().
    permission_classes = [IsAuthenticatedAnyRole]
    serializer_class = SaleSerializer

    def get_queryset(self):
        qs = (
            Sale.objects.select_related("operator", "channel")
            .prefetch_related("gifts", "operator_lines__operator", "partner_lines__partner")
            .annotate(total_price=F("amount") - F("discount"))
        )
        profile = getattr(self.request.user, "profile", None)
        if getattr(profile, "role", None) == "operator":
            # Operators can only see sales they themselves created (their own
            # pending/rejected/confirmed items). Prevents peeking at colleagues.
            return qs.filter(created_by=self.request.user)
        return qs

    def _guard_writes(self):
        profile = getattr(self.request.user, "profile", None)
        if getattr(profile, "role", None) == "operator":
            from rest_framework.exceptions import PermissionDenied

            raise PermissionDenied("Operators cannot modify sales.")

    def update(self, request, *args, **kwargs):
        """
        PUT  → full replace via `sale_full_update` (requires complete payload).
        PATCH → surgical update via `sale_partial_update` (only whitelisted
                scalar fields; preserves operator/partner lines, imei, amount).
        Both are exposed on the same URL so existing inline-edit callers
        (`PATCH /sales/{id}/` with just `sold_at`) keep working.
        """
        self._guard_writes()
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
        self._guard_writes()
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


class SaleRejectApi(APIView):
    permission_classes = [IsTeamLead]

    def post(self, request, pk: int):
        sale = sale_get(pk)
        if not sale:
            return Response({"detail": "Not found"}, status=404)
        reason = (request.data or {}).get("reason", "")
        try:
            sale_reject(sale=sale, user=request.user, reason=reason)
        except ApplicationError as exc:
            return Response(
                {"detail": exc.message, **exc.extra}, status=status.HTTP_400_BAD_REQUEST
            )
        return Response(SaleSerializer(sale).data)


class SalePendingListApi(APIView):
    """
    GET /api/sales/pending/ — все продажи со status=pending, свежие сверху.
    Показывается менеджеру в /sales/pending. Photo URLs — абсолютные,
    чтобы фронт мог рендерить `<img src>` напрямую.
    """

    permission_classes = [IsTeamLead]

    def get(self, request):
        qs = (
            Sale.objects.filter(status=SaleStatus.PENDING, is_deleted=False)
            .select_related("operator", "channel", "created_by")
            .prefetch_related(
                "operator_lines__operator", "partner_lines__partner", "gifts"
            )
            .annotate(total_price=F("amount") - F("discount"))
            .order_by("-created_at")
        )
        return Response(
            {
                "results": SaleSerializer(
                    qs, many=True, context={"request": request}
                ).data,
                "count": qs.count(),
            }
        )


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
        except Exception as exc:
            return Response({"detail": f"Не удалось разобрать файл: {exc}"}, status=400)
        return Response(result.as_dict(), status=status.HTTP_200_OK)

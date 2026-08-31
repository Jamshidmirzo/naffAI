import datetime as dt

from django.utils.dateparse import parse_datetime
from rest_framework import serializers
from rest_framework.exceptions import NotFound, ValidationError
from rest_framework.generics import ListCreateAPIView, RetrieveUpdateAPIView
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.analytics.selectors import resolve_period
from apps.users.permissions import IsTeamLead, IsTeamLeadOrManagerReadOnly
from apps.users.selectors import account_state, user_by_operator

from .models import Operator
from .selectors import (
    operator_achievements,
    operator_get,
    operator_list,
    operator_plan_progress,
    operator_stats,
    operators_with_birthday_today_public,
)
from .services import (
    operator_create,
    operator_deactivate,
    operator_delete,
    operator_plan_upsert,
    operator_reactivate,
    operator_self_update_preferences,
    operator_update,
)


class OperatorSerializer(serializers.ModelSerializer):
    plan_target = serializers.DecimalField(
        max_digits=16, decimal_places=2, read_only=True, allow_null=True, required=False, default=None
    )
    plan_actual = serializers.DecimalField(
        max_digits=16, decimal_places=2, read_only=True, required=False, default=None
    )
    account = serializers.SerializerMethodField()
    sticker = serializers.SerializerMethodField()
    forgotten_checkouts_count = serializers.SerializerMethodField()

    class Meta:
        model = Operator
        fields = [
            "id",
            "full_name",
            "phone",
            "personal_phone",
            "status",
            "hired_at",
            "note",
            "blocking_gate_enabled",
            "require_checkin_enabled",
            "birth_date",
            "created_at",
            "updated_at",
            "plan_target",
            "plan_actual",
            "account",
            "sticker",
            "forgotten_checkouts_count",
            # 2026-08-31: payroll overrides (см. миграцию 0008).
            "salary_uzs",
            "shift_start",
            "shift_end",
            "grace_period_min",
            "late_penalty_uzs",
            "weekly_day_off",
            "weekly_free_absences",
        ]
        read_only_fields = [
            "id",
            "created_at",
            "updated_at",
            "account",
            "sticker",
            "forgotten_checkouts_count",
        ]
        extra_kwargs = {
            # Опциональный на write — существующие PATCH'и без него
            # (edit-модалка правит full_name/phone/hired_at/status/note)
            # должны продолжать работать. Только если явно передан —
            # `operator_update` его применит.
            "blocking_gate_enabled": {"required": False},
            "require_checkin_enabled": {"required": False},
            "birth_date": {"required": False, "allow_null": True},
            "salary_uzs": {"required": False, "allow_null": True},
            "shift_start": {"required": False, "allow_null": True},
            "shift_end": {"required": False, "allow_null": True},
            "grace_period_min": {"required": False, "allow_null": True},
            "late_penalty_uzs": {"required": False, "allow_null": True},
            "weekly_day_off": {"required": False, "allow_null": True},
            "weekly_free_absences": {"required": False, "allow_null": True},
        }

    def get_account(self, obj: Operator) -> dict:
        return account_state(user_by_operator(obj))

    def get_sticker(self, obj: Operator) -> dict | None:
        try:
            sticker = obj.sticker  # reverse OneToOne
        except Exception:
            return None
        return {
            "emoji": sticker.emoji,
            "is_rare": sticker.is_rare,
        }

    def get_forgotten_checkouts_count(self, obj: Operator) -> int:
        """
        Сколько раз этот оператор «забыл выйти» за последние 30 дней
        (auto_closed логи без backfill'a). Для менеджерского списка —
        колонка с бейджем; ≥5 подсвечивается красным.

        Реализация: если сериалайзер получает готовый dict из контекста
        (bulk-preloaded), используем его — иначе fallback на per-row
        селектор. Так на списке из ~15 операторов делаем один GROUP BY
        вместо 15 отдельных запросов.
        """
        preloaded = self.context.get("forgotten_counts") if self.context else None
        if isinstance(preloaded, dict):
            return int(preloaded.get(obj.id, 0))
        # Fallback (detail view / non-list contexts).
        from apps.attendance.selectors import forgotten_checkouts_count

        return forgotten_checkouts_count(obj)


class OperatorListCreateApi(ListCreateAPIView):
    permission_classes = [IsTeamLeadOrManagerReadOnly]
    serializer_class = OperatorSerializer

    def get_queryset(self):
        return operator_list(
            search=self.request.query_params.get("search"),
            status=self.request.query_params.get("status"),
            include_inactive=self.request.query_params.get("include_inactive", "1") != "0",
            with_plan=True,
        )

    def get_serializer_context(self):
        """
        Preload forgotten-checkouts counts one query per list, not N.

        Мы пейджим список операторов (даже если пагинация внутри
        `operator_list` не включена явно, DRF всё равно применяет
        page-slice в `list()` → paginate_queryset). Достаём id'шники из
        уже-отрендеренного queryset'а через `filter_queryset`, идём в
        selectors bulk-batch — сериалайзер потом читает готовый dict
        через self.context.
        """
        context = super().get_serializer_context()
        try:
            qs = self.filter_queryset(self.get_queryset())
            operator_ids = list(qs.values_list("id", flat=True))
        except Exception:
            operator_ids = []
        if operator_ids:
            from apps.attendance.selectors import forgotten_checkouts_bulk

            context["forgotten_counts"] = forgotten_checkouts_bulk(operator_ids)
        return context

    def perform_create(self, serializer):
        instance = operator_create(user=self.request.user, **serializer.validated_data)
        serializer.instance = instance


class OperatorDetailApi(RetrieveUpdateAPIView):
    permission_classes = [IsTeamLead]
    serializer_class = OperatorSerializer
    queryset = Operator.objects.all()

    def perform_update(self, serializer):
        instance = operator_update(
            operator=serializer.instance, user=self.request.user, **serializer.validated_data
        )
        serializer.instance = instance


class OperatorDeactivateApi(APIView):
    permission_classes = [IsTeamLead]

    def post(self, request, pk: int):
        op = operator_get(pk)
        if not op:
            return Response({"detail": "Not found"}, status=404)
        operator_deactivate(operator=op, user=request.user)
        payload = OperatorSerializer(op).data
        # Surface the counters the service attached on `op` so the UI
        # can toast "Deactivated, N leads reassigned".
        payload["rebalanced_count"] = getattr(op, "rebalanced_count", 0)
        payload["callbacks_moved"] = getattr(op, "callbacks_moved", 0)
        return Response(payload)


class OperatorReactivateApi(APIView):
    permission_classes = [IsTeamLead]

    def post(self, request, pk: int):
        op = operator_get(pk)
        if not op:
            return Response({"detail": "Not found"}, status=404)
        operator_reactivate(operator=op, user=request.user)
        payload = OperatorSerializer(op).data
        # Same shape as OperatorDeactivateApi so the FE can render one
        # generic toast: "Активирован — N лидов подтянуто от других".
        payload["rebalanced_count"] = getattr(op, "rebalanced_count", 0)
        return Response(payload)


class OperatorDeleteApi(APIView):
    permission_classes = [IsTeamLead]

    def delete(self, request, operator_id: int):
        op = operator_get(operator_id)
        if not op:
            return Response({"detail": "Not found"}, status=404)
        deleted_related = operator_delete(operator=op, user=request.user)
        return Response({"deleted_related": deleted_related}, status=200)


class OperatorPlanApi(APIView):
    permission_classes = [IsTeamLeadOrManagerReadOnly]

    def get(self, request, pk: int):
        op = operator_get(pk)
        if not op:
            return Response({"detail": "Not found"}, status=404)
        today = dt.date.today()
        year = int(request.query_params.get("year", today.year))
        month = int(request.query_params.get("month", today.month))
        data = operator_plan_progress(operator=op, year=year, month=month)
        data["achievements"] = operator_achievements(operator=op, year=year, month=month)
        return Response(data)

    def put(self, request, pk: int):
        if not IsTeamLead().has_permission(request, self):
            return Response(status=403)
        op = operator_get(pk)
        if not op:
            return Response({"detail": "Not found"}, status=404)
        today = dt.date.today()
        year = int(request.data.get("year", today.year))
        month = int(request.data.get("month", today.month))
        target = request.data.get("target_amount")
        if target is None:
            raise ValidationError({"target_amount": "Required"})
        operator_plan_upsert(operator=op, year=year, month=month, target_amount=target, user=request.user)
        return Response(operator_plan_progress(operator=op, year=year, month=month))


def _parse(value):
    return parse_datetime(value) if value else None


class OperatorStatsApi(APIView):
    """
    Full statistics for one operator inside a period window.

    Query params (all optional):
      - `period=day|week|month` — auto-derived window (defaults to `month`)
      - `date_from` / `date_to` — explicit ISO datetimes (override `period`)
      - `include_payroll=0` — skip the monthly payroll block

    Returns a compound payload built by `operator_stats(...)`, plus an
    optional `payroll` block for the current calendar month.
    """

    permission_classes = [IsTeamLeadOrManagerReadOnly]

    def get(self, request, pk: int):
        op = operator_get(pk)
        if not op:
            return Response({"detail": "Not found"}, status=404)

        period = request.query_params.get("period")
        date_from, date_to = _parse(request.query_params.get("date_from")), _parse(
            request.query_params.get("date_to")
        )
        if date_from is not None or date_to is not None:
            effective_period = "custom"
        elif period == "all":
            effective_period = "all"
            date_from, date_to = None, None
        else:
            effective_period = period or "all"
            if effective_period != "all":
                p_from, p_to = resolve_period(effective_period)
                date_from, date_to = p_from, p_to

        payload = operator_stats(operator=op, date_from=date_from, date_to=date_to)
        payload["period"] = effective_period

        today = dt.date.today()
        payload["plan"] = operator_plan_progress(operator=op, year=today.year, month=today.month)
        payload["achievements"] = operator_achievements(operator=op, year=today.year, month=today.month)

        include_payroll = request.query_params.get("include_payroll", "1") != "0"
        if include_payroll:
            from apps.payroll.services import compute_monthly_payroll

            lines = compute_monthly_payroll(
                year=today.year, month=today.month, operators=[op]
            )
            payload["payroll"] = lines[0].as_dict() if lines else None
        return Response(payload)


class MePreferencesApi(APIView):
    """
    GET/PATCH /api/me/preferences/ — operator's own notification prefs.

    Only usable by users whose profile is linked to an `Operator`. Team
    leads and managers get 404 (they have no operator row to configure).
    """

    permission_classes = [IsAuthenticated]

    class OutputSerializer(serializers.Serializer):
        daily_lesson_opt_out = serializers.BooleanField()

    class InputSerializer(serializers.Serializer):
        daily_lesson_opt_out = serializers.BooleanField(required=False)

    def _get_operator(self, request) -> Operator:
        profile = getattr(request.user, "profile", None)
        op = getattr(profile, "operator", None) if profile else None
        if not op:
            raise NotFound("Настройки доступны только операторам")
        return op

    def get(self, request):
        op = self._get_operator(request)
        return Response({"daily_lesson_opt_out": op.daily_lesson_opt_out})

    def patch(self, request):
        op = self._get_operator(request)
        serializer = self.InputSerializer(data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        op = operator_self_update_preferences(
            operator=op,
            user=request.user,
            **serializer.validated_data,
        )
        return Response({"daily_lesson_opt_out": op.daily_lesson_opt_out})


class OperatorsBirthdayTodayApi(APIView):
    """
    GET /operators/birthdays-today/ — список активных именинников на
    сегодня. Только для менеджера / team-lead / superadmin (карточка на
    дашборде). Год ДР наружу не отдаём, только `age`.

    Ответ:
        [
          {"operator_id": 51, "full_name": "Test Bonu", "phone": "+998…",
           "age": 30, "status": "active"},
          ...
        ]
    Пустой ответ = сегодня никто не празднует. Клиент может тогда просто
    не рендерить карточку.
    """

    permission_classes = [IsTeamLeadOrManagerReadOnly]

    def get(self, request):
        return Response(operators_with_birthday_today_public())

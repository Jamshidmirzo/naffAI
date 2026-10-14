import datetime as dt

from django.utils.dateparse import parse_datetime
from rest_framework import serializers
from rest_framework.exceptions import NotFound, ValidationError
from rest_framework.generics import ListCreateAPIView, RetrieveUpdateAPIView
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.analytics.selectors import resolve_period
from apps.common.exceptions import ApplicationError
from apps.users.permissions import IsManager, IsTeamLead, IsTeamLeadOrManagerReadOnly
from apps.users.selectors import (
    InvalidManagerFilter,
    account_state,
    operator_ids_for_manager_filter,
    user_by_operator,
    visible_operator_ids,
)

from .models import DayOffStatus, Operator, OperatorDayOff
from .permissions import IsDestructiveActionPinVerified
from .selectors import (
    deleted_operators_history,
    operator_achievements,
    operator_get,
    operator_list,
    operator_plan_progress,
    operator_stats,
    operators_floor_snapshot,
    operators_with_birthday_today_public,
)
from .services import (
    day_off_context,
    day_off_request_approve,
    day_off_request_create,
    day_off_request_reject,
    operator_create,
    operator_deactivate,
    operator_delete,
    operator_plan_upsert,
    operator_reactivate,
    operator_self_update_preferences,
    operator_set_paused,
    operator_update,
    operators_bulk_set_manager,
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
    avatar_url = serializers.SerializerMethodField()
    managed_by_id = serializers.PrimaryKeyRelatedField(
        source="managed_by",
        queryset=__import__("django.contrib.auth", fromlist=["get_user_model"]).get_user_model().objects.all(),
        allow_null=True,
        required=False,
    )

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
            # 2026-10-08: opt-in флаг для WebRTC-живого стрима (apps.livestream).
            "livestream_enabled",
            "is_paused",
            "paused_at",
            "birth_date",
            "created_at",
            "updated_at",
            "plan_target",
            "plan_actual",
            "account",
            "sticker",
            "forgotten_checkouts_count",
            # 2026-10-12: avatar snapshot (absolute URL + updated_at).
            "avatar_url",
            # 2026-10-06: 3-level hierarchy ownership.
            "managed_by_id",
            # 2026-08-31: payroll overrides (см. миграцию 0008).
            "salary_uzs",
            "shift_start",
            "shift_end",
            "grace_period_min",
            "late_penalty_uzs",
            "weekly_day_off",
            "weekly_free_absences",
            # 2026-08-31 two-gate payroll (миграция 0009).
            "attendance_bonus_uzs",
            "sales_bonus_uzs",
            "sales_gate_pct",
        ]
        read_only_fields = [
            "id",
            "created_at",
            "updated_at",
            "account",
            "sticker",
            "forgotten_checkouts_count",
            "avatar_url",
            # Pause состояние меняется ТОЛЬКО через отдельные POST-эндпоинты
            # /pause/ и /unpause/ (proходят через `operator_set_paused` — там
            # audit-лог и timestamps). Не даём тихо править через PATCH.
            "is_paused",
            "paused_at",
        ]
        extra_kwargs = {
            # Опциональный на write — существующие PATCH'и без него
            # (edit-модалка правит full_name/phone/hired_at/status/note)
            # должны продолжать работать. Только если явно передан —
            # `operator_update` его применит.
            "blocking_gate_enabled": {"required": False},
            "require_checkin_enabled": {"required": False},
            "livestream_enabled": {"required": False},
            "birth_date": {"required": False, "allow_null": True},
            "salary_uzs": {"required": False, "allow_null": True},
            "shift_start": {"required": False, "allow_null": True},
            "shift_end": {"required": False, "allow_null": True},
            "grace_period_min": {"required": False, "allow_null": True},
            "late_penalty_uzs": {"required": False, "allow_null": True},
            "weekly_day_off": {"required": False, "allow_null": True},
            "weekly_free_absences": {"required": False, "allow_null": True},
            "attendance_bonus_uzs": {"required": False, "allow_null": True},
            "sales_bonus_uzs": {"required": False, "allow_null": True},
            "sales_gate_pct": {"required": False, "allow_null": True},
        }

    def validate(self, attrs):
        """
        Permission gate for `managed_by` reassignment.

          * superadmin / superuser: free assignment to anyone.
          * super_manager: shared senior tier — can assign to self or
            to any manager / team_lead / super_manager in the system.
          * manager / team_lead: can set/unset ownership on their own ops
            but can only point `managed_by` at themselves (or NULL).
          * else: 403.

        Nullable passthrough — if the PATCH payload doesn't include
        `managed_by_id`, `attrs` won't have `managed_by` and this is a
        no-op.
        """
        if "managed_by" not in attrs:
            return attrs

        actor = self.context["request"].user
        from apps.users.models import Profile as _Profile
        from apps.users.models import Role as _Role

        profile = getattr(actor, "profile", None)
        role = profile.role if profile else None
        if actor.is_superuser or role == _Role.SUPERADMIN:
            return attrs

        new_owner = attrs["managed_by"]  # User instance or None
        if role == _Role.SUPER_MANAGER:
            # Super_managers — shared tier, назначают любому senior.
            if new_owner is not None:
                new_role = getattr(
                    _Profile.objects.filter(user_id=new_owner.id).first(),
                    "role", None,
                )
                if new_role not in (
                    _Role.MANAGER,
                    _Role.TEAM_LEAD,
                    _Role.SUPER_MANAGER,
                    _Role.SUPERADMIN,
                ):
                    raise serializers.ValidationError(
                        {"managed_by_id": "Можно назначать только senior-роли"}
                    )
            return attrs

        if role in (_Role.MANAGER, _Role.TEAM_LEAD):
            if new_owner is not None and new_owner.id != actor.id:
                raise serializers.ValidationError(
                    {"managed_by_id": "Можно назначать только себе или оставить пустым"}
                )
            return attrs

        raise serializers.ValidationError(
            {"managed_by_id": "Недостаточно прав для изменения ownership"}
        )

    def get_avatar_url(self, obj: Operator) -> str | None:
        if not obj.avatar:
            return None
        request = self.context.get("request") if self.context else None
        try:
            raw = obj.avatar.url
        except Exception:
            return None
        if request is not None:
            try:
                return request.build_absolute_uri(raw)
            except Exception:
                return raw
        return raw

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
    pagination_class = None  # список операторов небольшой (~30); фронт грузит одним запросом

    def get_queryset(self):
        return operator_list(
            search=self.request.query_params.get("search"),
            status=self.request.query_params.get("status"),
            include_inactive=self.request.query_params.get("include_inactive", "1") != "0",
            with_plan=True,
            # Ownership scope — super_manager видит свою ветку (свои direct
            # + все operators своих managers), обычный manager видит свои +
            # legacy unassigned (NULL) pool. Superadmin — всех.
            visible_operator_ids=visible_operator_ids(self.request.user),
            # Secondary filter поверх scope: super_manager-дропдаун
            # «фильтр по менеджеру». `managed_by=null` → unassigned pool.
            managed_by=self.request.query_params.get("managed_by"),
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
        # Ownership autoset для обычного manager'а: если он не указал
        # `managed_by_id` в payload'е, backend сам подставляет self —
        # так новый оператор сразу попадает в scope своего создателя и
        # не висит в legacy «общем пуле». super_manager/superadmin —
        # явно выбирают dropdown'ом; если None, оставляем None (legacy).
        validated = dict(serializer.validated_data)
        actor = self.request.user
        if "managed_by" not in validated or validated.get("managed_by") is None:
            from apps.users.models import Role as _Role

            profile = getattr(actor, "profile", None)
            role = profile.role if profile else None
            if role in (_Role.MANAGER, _Role.TEAM_LEAD):
                validated["managed_by"] = actor
        instance = operator_create(user=actor, **validated)
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
    # Destructive: strips leads from the operator and triggers rescue cascade
    # to redistribute touched leads across the remaining active team. Guarded
    # by the same attendance PIN as the payroll/attendance edit views, but
    # WITHOUT the superadmin bypass — even root has to type 6810.
    permission_classes = [IsTeamLead, IsDestructiveActionPinVerified]

    def post(self, request, pk: int):
        op = operator_get(pk)
        if not op:
            return Response({"detail": "Not found"}, status=404)
        # Флаг `rescue_touched` — «трогать ли touched non-terminal лиды».
        # Параметр `mode`:
        #   * "reassign" (default, 2026-09-10) — раскидать touched-лидов RR
        #     активным операторам с сохранением статуса+истории.
        #   * "mark_lost" — legacy: пометить как system-lost.
        rescue_touched = request.data.get("rescue_touched", True)
        if isinstance(rescue_touched, str):
            rescue_touched = rescue_touched.lower() not in ("0", "false", "no")
        mode = str(request.data.get("mode", "reassign")).strip() or "reassign"
        if mode not in ("reassign", "mark_lost"):
            mode = "reassign"
        operator_deactivate(
            operator=op,
            user=request.user,
            rescue_touched=bool(rescue_touched),
            mode=mode,
        )
        payload = OperatorSerializer(op).data
        # Surface the counters the service attached on `op` so the UI
        # can toast "Deactivated, N leads reassigned + M touched reassigned".
        payload["rebalanced_count"] = getattr(op, "rebalanced_count", 0)
        payload["callbacks_moved"] = getattr(op, "callbacks_moved", 0)
        payload["touched_needs_review_count"] = getattr(
            op, "touched_needs_review_count", 0
        )
        payload["touched_reassigned_count"] = getattr(
            op, "touched_reassigned_count", 0
        )
        payload["touched_system_lost_count"] = getattr(
            op, "touched_system_lost_count", 0
        )
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


class OperatorPauseApi(APIView):
    """
    POST /operators/{pk}/pause/    → is_paused=True
    POST /operators/{pk}/unpause/  → is_paused=False

    Мягкий выкл — оператор перестаёт получать НОВЫЕ лиды через любой
    auto-канал (round-robin / refill / morning-split / qimmatlik-retry /
    rescue-target / bulk_reassign round_robin). Его уже назначенные
    лиды **остаются на нём** — никаких rebalanced / rescue / lost side
    effects (в отличие от `operator_deactivate`).

    Флаг маршрутизируется через `paused` в pattern-based dispatch по URL
    (у нас две отдельные routes, чтобы фронт не гонял тело запроса).
    """

    permission_classes = [IsTeamLead]
    paused: bool = True  # override в as_view() через `initkwargs`

    def post(self, request, pk: int):
        op = operator_get(pk)
        if not op:
            return Response({"detail": "Not found"}, status=404)
        operator_set_paused(operator=op, paused=self.paused, user=request.user)
        return Response(OperatorSerializer(op).data)


class OperatorDeleteApi(APIView):
    """
    Hard-delete оператора с обязательным комментарием-причиной.

    `comment` обязателен (min 10 символов) и записывается в
    `AuditLog.comment` вместе со snapshot'ом. Нужно для разбора «кто
    зачем удалил»: за октябрь 2026 один super_manager тихо снёс 14
    операторов + 21 продажу на 133М из отчётов, с пустыми audit-
    комментариями мы восстановили только по snapshot'у, без мотива.

    Принимаем и в body DELETE-запроса, и в query-string, т.к. не все
    HTTP-клиенты шлют body с DELETE (у axios это OK, но FileSystemError
    или curl без `-d` упадут). Фронт передаёт в теле.
    """

    permission_classes = [IsTeamLead]

    MIN_COMMENT_LEN = 10

    def delete(self, request, operator_id: int):
        op = operator_get(operator_id)
        if not op:
            return Response({"detail": "Not found"}, status=404)

        # Тело DELETE доступно через request.data (DRF parses it), fallback
        # на query-string для нестандартных клиентов.
        raw_comment = request.data.get("comment") if hasattr(request, "data") else None
        if raw_comment is None:
            raw_comment = request.query_params.get("comment", "")
        comment = (raw_comment or "").strip()
        if len(comment) < self.MIN_COMMENT_LEN:
            return Response(
                {
                    "detail": (
                        "Укажите причину удаления (минимум "
                        f"{self.MIN_COMMENT_LEN} символов) — она попадёт в audit."
                    ),
                    "field": "comment",
                },
                status=400,
            )

        deleted_related = operator_delete(operator=op, user=request.user, note=comment)
        return Response({"deleted_related": deleted_related}, status=200)


class DeletedOperatorsListApi(APIView):
    """
    GET /api/operators/deleted/ — история hard-удалённых операторов.

    Читается из `AuditLog` (entity='operators.Operator', action='delete').
    Для каждого удаления возвращаем snapshot, кто/когда/зачем удалил,
    сколько sales этот оператор создал за 90 дней до удаления, и
    сколько из них уже восстановлены (по пометке `[RESTORED after
    operator delete]` в sale.comment).

    Permission: senior-role (IsManager = team_lead/manager/super_manager/
    superadmin). На фронте маршрут завёрнут в RoleGate allow=["super_manager"]
    с superadmin-bypass'ом — но API пускает всех senior, т.к. это ТОЛЬКО
    чтение audit'a, никаких write-side effects.
    """

    permission_classes = [IsManager]

    def get(self, request):
        limit_raw = request.query_params.get("limit", "500")
        try:
            limit = max(1, min(1000, int(limit_raw)))
        except (TypeError, ValueError):
            limit = 500
        rows = deleted_operators_history(limit=limit)
        return Response({"results": rows, "count": len(rows)})


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


# ---------------------------------------------------------------------------
# Day-off requests API
# ---------------------------------------------------------------------------


class DayOffRequestSerializer(serializers.ModelSerializer):
    operator_id = serializers.IntegerField(source="operator.id", read_only=True)
    operator_name = serializers.CharField(source="operator.full_name", read_only=True)
    decided_by_name = serializers.SerializerMethodField()

    class Meta:
        model = OperatorDayOff
        fields = [
            "id", "operator_id", "operator_name", "date", "status",
            "reason", "decision_note", "decided_at", "decided_by_name",
            "created_at", "updated_at",
        ]
        read_only_fields = fields

    def get_decided_by_name(self, obj):
        if not obj.decided_by_id:
            return None
        u = obj.decided_by
        return (u.get_full_name() or u.username or "").strip() or None


class DayOffCreateInputSerializer(serializers.Serializer):
    operator_id = serializers.IntegerField(required=False, allow_null=True)
    date = serializers.DateField()
    reason = serializers.CharField(required=False, allow_blank=True, default="", max_length=2000)


class DayOffDecideInputSerializer(serializers.Serializer):
    note = serializers.CharField(required=False, allow_blank=True, default="", max_length=2000)


def _profile_role(user):
    profile = getattr(user, "profile", None)
    return getattr(profile, "role", None) if profile else None


def _profile_operator_id(user):
    profile = getattr(user, "profile", None)
    return getattr(profile, "operator_id", None) if profile else None


def _is_manager(user):
    role = _profile_role(user)
    return role in ("manager", "team_lead", "superadmin")


class DayOffCreateApi(APIView):
    """POST /operators/day-off/ — создать заявку на выходной."""
    permission_classes = [IsAuthenticated]

    def post(self, request):
        ser = DayOffCreateInputSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        v = ser.validated_data
        target_op_id = v.get("operator_id")
        if _is_manager(request.user):
            if not target_op_id:
                return Response({"detail": "operator_id обязателен для менеджера"}, status=400)
            op = operator_get(target_op_id)
            if not op:
                return Response({"detail": "Оператор не найден"}, status=404)
        else:
            my_op_id = _profile_operator_id(request.user)
            if not my_op_id:
                return Response({"detail": "Пользователь не привязан к оператору"}, status=400)
            if target_op_id and target_op_id != my_op_id:
                return Response({"detail": "Нельзя создать заявку от имени другого оператора"}, status=403)
            op = operator_get(my_op_id)
            if not op:
                return Response({"detail": "Оператор не найден"}, status=404)
        try:
            req = day_off_request_create(
                operator=op, date=v["date"], reason=v.get("reason") or "",
                requested_by=request.user,
            )
        except ApplicationError as exc:
            return Response({"detail": exc.message, **exc.extra}, status=400)
        return Response(DayOffRequestSerializer(req).data, status=201)


class MyDayOffListApi(APIView):
    """GET /my/day-off/ — свои заявки (для оператора)."""
    permission_classes = [IsAuthenticated]

    def get(self, request):
        my_op_id = _profile_operator_id(request.user)
        if not my_op_id:
            return Response({"results": [], "count": 0})
        qs = (
            OperatorDayOff.objects
            .filter(operator_id=my_op_id)
            .select_related("operator", "decided_by")
            .order_by("-date", "-created_at")[:100]
        )
        rows = DayOffRequestSerializer(qs, many=True).data
        return Response({"results": rows, "count": len(rows)})


class DayOffPendingListApi(APIView):
    """GET /operators/day-off/pending/ — pending-заявки для менеджера."""
    permission_classes = [IsTeamLead]

    def get(self, request):
        qs = (
            OperatorDayOff.objects
            .filter(status=DayOffStatus.PENDING)
            .select_related("operator", "requested_by")
            .order_by("date", "created_at")
        )
        rows = DayOffRequestSerializer(qs, many=True).data
        return Response({"results": rows, "count": len(rows)})


class DayOffContextApi(APIView):
    """GET /operators/day-off/{pk}/context/ — контекст для решения."""
    permission_classes = [IsTeamLead]

    def get(self, request, pk: int):
        req = OperatorDayOff.objects.select_related("operator").filter(pk=pk).first()
        if not req:
            return Response({"detail": "Not found"}, status=404)
        ctx = day_off_context(
            operator=req.operator, date=req.date, exclude_request_id=req.id,
        )
        payload = DayOffRequestSerializer(req).data
        payload["context"] = ctx
        return Response(payload)


class DayOffApproveApi(APIView):
    """POST /operators/day-off/{pk}/approve/"""
    permission_classes = [IsTeamLead]

    def post(self, request, pk: int):
        req = OperatorDayOff.objects.select_related("operator").filter(pk=pk).first()
        if not req:
            return Response({"detail": "Not found"}, status=404)
        ser = DayOffDecideInputSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        try:
            req = day_off_request_approve(
                request=req, decided_by=request.user, note=ser.validated_data.get("note") or "",
            )
        except ApplicationError as exc:
            return Response({"detail": exc.message, **exc.extra}, status=400)
        return Response(DayOffRequestSerializer(req).data)


class DayOffRejectApi(APIView):
    """POST /operators/day-off/{pk}/reject/  (note обязательна)."""
    permission_classes = [IsTeamLead]

    def post(self, request, pk: int):
        req = OperatorDayOff.objects.select_related("operator").filter(pk=pk).first()
        if not req:
            return Response({"detail": "Not found"}, status=404)
        ser = DayOffDecideInputSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        try:
            req = day_off_request_reject(
                request=req, decided_by=request.user, note=ser.validated_data.get("note") or "",
            )
        except ApplicationError as exc:
            return Response({"detail": exc.message, **exc.extra}, status=400)
        return Response(DayOffRequestSerializer(req).data)


# ---------------------------------------------------------------------------
# Avatar / snapshot APIs (2026-10-12).
# ---------------------------------------------------------------------------

from rest_framework.parsers import FormParser, MultiPartParser  # noqa: E402

from .services import (  # noqa: E402
    operator_set_avatar,
    operator_snapshot_request,
)


def _operator_avatar_payload(operator: Operator, request) -> dict:
    url = ""
    if operator.avatar:
        try:
            raw = operator.avatar.url
            url = request.build_absolute_uri(raw) if request else raw
        except Exception:
            url = ""
    return {
        "operator_id": operator.id,
        "avatar_url": url or None,
        "avatar_updated_at": (
            operator.avatar_updated_at.isoformat()
            if operator.avatar_updated_at
            else None
        ),
    }


class OperatorMeAvatarApi(APIView):
    """
    POST /api/operators/me/avatar/ — оператор загружает свой аватар
    (file picker или webcam-snapshot). Multipart, поле `avatar`.
    """

    permission_classes = [IsAuthenticated]
    parser_classes = [MultiPartParser, FormParser]

    def post(self, request):
        profile = getattr(request.user, "profile", None)
        op_id = getattr(profile, "operator_id", None) if profile else None
        if not op_id:
            raise NotFound("Доступно только операторам")
        op = operator_get(op_id)
        if not op:
            raise NotFound("Оператор не найден")
        f = request.FILES.get("avatar")
        if not f:
            raise ValidationError({"avatar": "Файл обязателен"})
        op = operator_set_avatar(operator=op, image_file=f, user=request.user)
        return Response(_operator_avatar_payload(op, request))


class OperatorAvatarApi(APIView):
    """
    POST /api/operators/<pk>/avatar/ — менеджер+ грузит аватар за
    конкретного оператора (file picker в карточке).
    """

    permission_classes = [IsManager]
    parser_classes = [MultiPartParser, FormParser]

    def post(self, request, pk: int):
        op = operator_get(pk)
        if not op:
            return Response({"detail": "Not found"}, status=404)
        f = request.FILES.get("avatar")
        if not f:
            raise ValidationError({"avatar": "Файл обязателен"})
        op = operator_set_avatar(operator=op, image_file=f, user=request.user)
        return Response(_operator_avatar_payload(op, request))


class OperatorSnapshotRequestApi(APIView):
    """
    POST /api/operators/<pk>/snapshot/request/ — менеджер+ шлёт пуш
    оператору «сделай снимок». Фронт у оператора открывает consent-
    модалку и после подтверждения грузит снимок через me/avatar/.
    """

    permission_classes = [IsManager]

    def post(self, request, pk: int):
        op = operator_get(pk)
        if not op:
            return Response({"detail": "Not found"}, status=404)
        sent = operator_snapshot_request(operator=op, requested_by=request.user)
        if sent == 0:
            return Response(
                {"detail": "У оператора нет связанного пользователя"}, status=400
            )
        return Response({"sent": sent}, status=202)


# ---------------------------------------------------------------------------
# 2026-10-14 design-atlas V2: «Пульт зала» + массовый перенос операторов.
# ---------------------------------------------------------------------------


class OperatorFloorApi(APIView):
    """
    GET /api/operators/floor/[?manager_id=<user_id>|none]

    Живой срез зала: state каждого оператора (call/wait/pause/late/absent/
    off/dayoff), квота, продажи сегодня, просроченные колбэки, план месяца.
    Скоуп — `visible_operator_ids`; `manager_id` — доп. фильтр для
    super_manager/superadmin (остальным игнорируется).

    Attendance-поля (`checked_in_at`, `late_minutes`) отдаются только при
    валидной attendance-PIN-сессии (superadmin — bypass), иначе null и
    `pin_verified=false`. Сам endpoint PIN не требует.
    """

    permission_classes = [IsAuthenticated, IsManager]

    def get(self, request):
        from apps.attendance.permissions import attendance_pin_access_granted

        try:
            filtered = operator_ids_for_manager_filter(
                request.user, request.query_params.get("manager_id")
            )
        except InvalidManagerFilter:
            raise ValidationError(
                {"manager_id": "Ожидается id пользователя или none"}
            ) from None
        operator_ids = filtered if filtered is not None else visible_operator_ids(request.user)
        payload = operators_floor_snapshot(
            operator_ids=operator_ids,
            pin_verified=attendance_pin_access_granted(request.user),
        )
        for row in payload["operators"]:
            if row["avatar_url"]:
                try:
                    row["avatar_url"] = request.build_absolute_uri(row["avatar_url"])
                except Exception:
                    pass
        return Response(payload)


class OperatorBulkSetManagerInputSerializer(serializers.Serializer):
    operator_ids = serializers.ListField(
        child=serializers.IntegerField(min_value=1), min_length=1, max_length=500
    )
    managed_by_id = serializers.IntegerField(allow_null=True, min_value=1)


class OperatorBulkSetManagerApi(APIView):
    """
    POST /api/operators/bulk-set-manager/
    body: {"operator_ids": [1, 2, 3], "managed_by_id": 7 | null}
    → 200 {"updated": [1, 2], "errors": [{"id": 3, "detail": "..."}]}

    Права — как у PATCH /operators/<id>/ (`IsTeamLead` + правила
    `OperatorSerializer.validate` для `managed_by_id`: manager/team_lead —
    только себе или null, super_manager — любому senior, superadmin — кому
    угодно). Недопустимый владелец → 400 целиком. Дополнительно (строже
    одиночного PATCH): операторы вне `visible_operator_ids` попадают в
    `errors`, а не переносятся.
    """

    permission_classes = [IsAuthenticated, IsTeamLead]

    def post(self, request):
        inp = OperatorBulkSetManagerInputSerializer(data=request.data)
        inp.is_valid(raise_exception=True)

        # Тот же валидатор владельца, что у одиночного PATCH.
        owner_ser = OperatorSerializer(
            data={"managed_by_id": inp.validated_data["managed_by_id"]},
            partial=True,
            context={"request": request},
        )
        owner_ser.is_valid(raise_exception=True)
        managed_by = owner_ser.validated_data.get("managed_by")

        result = operators_bulk_set_manager(
            operator_ids=inp.validated_data["operator_ids"],
            managed_by=managed_by,
            user=request.user,
            visible_operator_ids=visible_operator_ids(request.user),
        )
        return Response(result)

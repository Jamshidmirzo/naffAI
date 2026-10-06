from django.contrib.auth import authenticate, get_user_model
from rest_framework import serializers, status
from rest_framework.authtoken.models import Token
from rest_framework.exceptions import NotFound
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from rest_framework.throttling import AnonRateThrottle

from apps.common.validators import normalize_uz_phone
from apps.operators.selectors import operator_get

from .permissions import IsManager
from .selectors import account_state, user_by_operator, visible_manager_user_ids
from .services import (
    account_activate,
    account_create_for_operator,
    account_deactivate,
    account_reset_password,
    account_soft_delete,
    password_view,
    profile_role_update,
    self_change_password,
)

User = get_user_model()


class LoginRateThrottle(AnonRateThrottle):
    scope = "login"


class LoginApi(APIView):
    permission_classes = [AllowAny]
    throttle_classes = [LoginRateThrottle]

    class InputSerializer(serializers.Serializer):
        username = serializers.CharField()
        password = serializers.CharField()

    def post(self, request):
        serializer = self.InputSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        raw_username = serializer.validated_data["username"]
        password = serializer.validated_data["password"]

        # Try phone-normalized username first (operator flow), then raw
        # (team lead / manager / historical accounts still login by name).
        normalized, valid = normalize_uz_phone(raw_username)
        candidates = [raw_username]
        if valid and normalized != raw_username:
            candidates.insert(0, normalized)

        user = None
        for candidate in candidates:
            user = authenticate(username=candidate, password=password)
            if user:
                break
        if not user:
            return Response(
                {"detail": "Неверный логин или пароль"},
                status=status.HTTP_400_BAD_REQUEST,
            )
        token, _ = Token.objects.get_or_create(user=user)
        profile = getattr(user, "profile", None)
        return Response(
            {
                "token": token.key,
                "username": user.username,
                "role": profile.role if profile else "team_lead",
                "is_superuser": user.is_superuser,
            }
        )


class MeApi(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        user = request.user
        profile = getattr(user, "profile", None)
        operator = profile.operator if profile and profile.operator else None
        operator_name = operator.full_name if operator else None
        display_name = operator_name or (user.get_full_name() or None)
        preferred_language = getattr(profile, "preferred_language", None) or "uz"
        # ДР — только для operator-роли. Managers/team_lead operator FK
        # не имеют, поэтому оба поля будут null. Год ДР отдаём только
        # владельцу профиля (сам оператор себе видит полную дату);
        # менеджер видит год через /operators/<id>/ (карточка).
        birth_date = operator.birth_date.isoformat() if operator and operator.birth_date else None
        is_birthday_today = bool(operator and operator.is_birthday_today())
        return Response(
            {
                "username": user.username,
                "role": profile.role if profile else "team_lead",
                "is_superuser": user.is_superuser,
                "operator_id": profile.operator_id if profile else None,
                "operator_name": operator_name,
                "display_name": display_name,
                "telegram_user_id": profile.telegram_user_id if profile else None,
                "preferred_language": preferred_language,
                "birth_date": birth_date,
                "is_birthday_today": is_birthday_today,
            }
        )

    def patch(self, request):
        """Self-service partial update.

        Поддерживаемые поля:
          - `preferred_language` — RU/UZ, любой аутентифицированный юзер;
          - `birth_date` — ISO-дата (или null для очистки), доступно
            только пользователю, у которого профиль привязан к оператору.

        Оба поля опциональны, PATCH принимает любой их набор.
        """
        import datetime as _dt

        user = request.user
        profile = getattr(user, "profile", None)
        if profile is None:
            from .models import Profile as _Profile
            profile = _Profile.objects.create(user=user)

        response_payload: dict = {}
        errors: dict = {}

        # --- preferred_language ---
        if "preferred_language" in request.data:
            lang = request.data.get("preferred_language")
            if lang not in ("ru", "uz"):
                errors["preferred_language"] = "must be 'ru' or 'uz'"
            else:
                profile.preferred_language = lang
                profile.save(update_fields=["preferred_language"])
                response_payload["preferred_language"] = profile.preferred_language

        # --- birth_date ---
        if "birth_date" in request.data:
            operator = profile.operator if profile.operator_id else None
            if operator is None:
                errors["birth_date"] = "Только операторы могут задавать дату рождения"
            else:
                raw = request.data.get("birth_date")
                if raw in (None, ""):
                    new_val = None
                else:
                    try:
                        new_val = _dt.date.fromisoformat(str(raw))
                    except (TypeError, ValueError):
                        new_val = "__invalid__"
                if new_val == "__invalid__":
                    errors["birth_date"] = "Неверный формат даты (ожидается YYYY-MM-DD)"
                else:
                    # Разумные границы: не в будущем, не раньше 1930.
                    if new_val is not None:
                        today = _dt.date.today()
                        if new_val > today:
                            errors["birth_date"] = "Дата рождения не может быть в будущем"
                        elif new_val.year < 1930:
                            errors["birth_date"] = "Год рождения слишком старый (<1930)"
                    if "birth_date" not in errors:
                        # Идёт через сервис, чтобы попасть в audit log.
                        from apps.operators.services import operator_self_update_birth_date

                        operator = operator_self_update_birth_date(
                            operator=operator, user=user, birth_date=new_val
                        )
                        response_payload["birth_date"] = (
                            operator.birth_date.isoformat() if operator.birth_date else None
                        )
                        response_payload["is_birthday_today"] = operator.is_birthday_today()

        # Fallback совместимости: старый контракт возвращал 400 при
        # отсутствии preferred_language — сохраняем то же поведение,
        # если пришёл пустой PATCH (никаких известных полей).
        if not response_payload and not errors:
            return Response(
                {"detail": "no supported fields provided"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        if errors:
            return Response(errors, status=status.HTTP_400_BAD_REQUEST)
        return Response(response_payload)


class LogoutApi(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request):
        Token.objects.filter(user=request.user).delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


# ---------------------------------------------------------------------------
# Self password change — any authenticated user
# ---------------------------------------------------------------------------


class SelfChangePasswordApi(APIView):
    permission_classes = [IsAuthenticated]

    class InputSerializer(serializers.Serializer):
        old_password = serializers.CharField()
        new_password = serializers.CharField()

    def post(self, request):
        serializer = self.InputSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        self_change_password(
            user=request.user,
            old_password=serializer.validated_data["old_password"],
            new_password=serializer.validated_data["new_password"],
        )
        return Response({"detail": "Пароль изменён"})


# ---------------------------------------------------------------------------
# Telegram-linking — the user asks the API for a one-time 6-digit code,
# then pastes `/link <code>` into @naffai_bot; the bot binds their
# telegram_user_id in place.
# ---------------------------------------------------------------------------


class TelegramLinkCodeApi(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request):
        import secrets as _secrets

        from django.utils import timezone
        import datetime as _dt

        from apps.users.models import Profile

        profile, _ = Profile.objects.get_or_create(user=request.user)
        code = f"{_secrets.randbelow(1_000_000):06d}"
        profile.tg_link_code = code
        profile.tg_link_code_expires_at = timezone.now() + _dt.timedelta(minutes=10)
        profile.save(update_fields=["tg_link_code", "tg_link_code_expires_at"])
        return Response(
            {
                "code": code,
                "expires_at": profile.tg_link_code_expires_at.isoformat(),
                "bot_username": "naffai_bot",
                "instruction": (
                    f"Откройте @naffai_bot и отправьте команду `/link {code}` — "
                    "в течение 10 минут."
                ),
            }
        )

    def delete(self, request):
        from apps.users.models import Profile

        profile = getattr(request.user, "profile", None)
        if profile is None:
            return Response(status=204)
        profile.telegram_user_id = None
        profile.tg_link_code = ""
        profile.tg_link_code_expires_at = None
        profile.save(
            update_fields=[
                "telegram_user_id",
                "tg_link_code",
                "tg_link_code_expires_at",
            ]
        )
        return Response(status=204)


# ---------------------------------------------------------------------------
# Manager admin surface — operator account CRUD
# ---------------------------------------------------------------------------


def _operator_or_404(operator_id: int):
    op = operator_get(operator_id)
    if op is None:
        raise NotFound("Оператор не найден")
    return op


def _account_response(user) -> dict:
    return {
        "operator_id": getattr(getattr(user, "profile", None), "operator_id", None),
        "user_id": user.id,
        **account_state(user),
    }


class OperatorAccountCreateApi(APIView):
    """POST /operators/{id}/account/ — create the operator's login."""

    permission_classes = [IsManager]

    class InputSerializer(serializers.Serializer):
        password = serializers.CharField(required=False, allow_blank=True)

    def post(self, request, operator_id: int):
        operator = _operator_or_404(operator_id)
        serializer = self.InputSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        user, plain = account_create_for_operator(
            operator=operator,
            actor=request.user,
            plain=serializer.validated_data.get("password") or None,
        )
        return Response(
            {**_account_response(user), "password": plain},
            status=status.HTTP_201_CREATED,
        )


class OperatorAccountPasswordViewApi(APIView):
    """GET /operators/{id}/account/password/ — audited plaintext lookup."""

    permission_classes = [IsManager]

    def get(self, request, operator_id: int):
        operator = _operator_or_404(operator_id)
        user = user_by_operator(operator)
        if user is None:
            raise NotFound("У оператора нет аккаунта")
        plain = password_view(actor=request.user, target_user=user)
        return Response({**_account_response(user), "password": plain})


class OperatorAccountResetPasswordApi(APIView):
    """POST /operators/{id}/account/reset-password/"""

    permission_classes = [IsManager]

    class InputSerializer(serializers.Serializer):
        password = serializers.CharField(required=False, allow_blank=True)

    def post(self, request, operator_id: int):
        operator = _operator_or_404(operator_id)
        user = user_by_operator(operator)
        if user is None:
            raise NotFound("У оператора нет аккаунта")
        serializer = self.InputSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        plain = account_reset_password(
            user=user,
            actor=request.user,
            plain=serializer.validated_data.get("password") or None,
        )
        return Response({**_account_response(user), "password": plain})


class OperatorAccountDeactivateApi(APIView):
    """POST /operators/{id}/account/deactivate/"""

    permission_classes = [IsManager]

    def post(self, request, operator_id: int):
        operator = _operator_or_404(operator_id)
        user = user_by_operator(operator)
        if user is None:
            raise NotFound("У оператора нет аккаунта")
        account_deactivate(user=user, actor=request.user)
        return Response(_account_response(user))


class OperatorAccountActivateApi(APIView):
    """POST /operators/{id}/account/activate/"""

    permission_classes = [IsManager]

    def post(self, request, operator_id: int):
        operator = _operator_or_404(operator_id)
        user = user_by_operator(operator)
        if user is None:
            raise NotFound("У оператора нет аккаунта")
        account_activate(user=user, actor=request.user)
        return Response(_account_response(user))


class OperatorAccountDeleteApi(APIView):
    """DELETE /operators/{id}/account/ — soft delete."""

    permission_classes = [IsManager]

    def delete(self, request, operator_id: int):
        operator = _operator_or_404(operator_id)
        user = user_by_operator(operator)
        if user is None:
            raise NotFound("У оператора нет аккаунта")
        account_soft_delete(user=user, actor=request.user)
        return Response(status=status.HTTP_204_NO_CONTENT)


# ---------------------------------------------------------------------------
# Users management (managers list + create + reset + delete)
# Mounted at /api/users/ from config.api_urls.
# ---------------------------------------------------------------------------

from django.utils import timezone
from .models import Profile, Role
from .services import AuditAction, audit_log_create
from .utils import generate_temp_password
from .services import user_password_set


class UserListCreateApi(APIView):
    """GET /users/ — list managers/team-leads; POST — create a new one."""

    permission_classes = [IsManager]

    class CreateSerializer(serializers.Serializer):
        username = serializers.CharField(max_length=150)
        password = serializers.CharField(required=False, allow_blank=True)
        role = serializers.ChoiceField(
            choices=[
                Role.MANAGER,
                Role.TEAM_LEAD,
                Role.SUPER_MANAGER,
                Role.SUPERADMIN,
            ],
            default=Role.MANAGER,
        )
        reports_to_id = serializers.IntegerField(required=False, allow_null=True)

    def get(self, request):
        # We only list web-only accounts (not operator-linked ones —
        # those are managed via /operators/{id}/account/…).
        #
        # Optional `?role=` filter — used by the OperatorSaleCreate
        # form's "менеджеры-партнёры" select. Accepts a single role
        # code (`manager`/`team_lead`/`super_manager`/`superadmin`) or a
        # comma-separated list. Silently ignores unknown codes so the
        # caller can't smuggle arbitrary predicates in.
        allowed_roles = {
            Role.MANAGER,
            Role.TEAM_LEAD,
            Role.SUPER_MANAGER,
            Role.SUPERADMIN,
        }
        role_param = (request.query_params.get("role") or "").strip()
        role_filter: set[str] = set()
        if role_param:
            for code in role_param.split(","):
                c = code.strip()
                if c in allowed_roles:
                    role_filter.add(c)

        qs = (
            User.objects.filter(is_active=True)
            .exclude(profile__operator__isnull=False)
            .select_related("profile")
            .order_by("username")
        )
        if role_filter:
            qs = qs.filter(profile__role__in=role_filter)

        # Scoping (2026-10-06 hierarchy):
        #   * superadmin  → all users (helper returns ids of every User);
        #   * super_manager → self + own managers (reports_to=self);
        #   * manager/team_lead → self only.
        # Legacy /users was fully open to any senior; this preserves
        # access for superadmin while narrowing для middle-tier owners.
        allowed_user_ids = visible_manager_user_ids(request.user)
        if allowed_user_ids:
            qs = qs.filter(id__in=allowed_user_ids)

        rows = []
        for user in qs:
            profile = getattr(user, "profile", None)
            rows.append({
                "id": user.id,
                "username": user.username,
                "full_name": user.get_full_name() or user.username,
                "role": profile.role if profile else "team_lead",
                "is_active": user.is_active,
                "is_superuser": user.is_superuser,
                "date_joined": user.date_joined.isoformat() if user.date_joined else None,
                "last_login": user.last_login.isoformat() if user.last_login else None,
                "preferred_language": getattr(profile, "preferred_language", None) or "uz",
                "reports_to_id": getattr(profile, "reports_to_id", None),
            })
        return Response(rows)

    def post(self, request):
        s = self.CreateSerializer(data=request.data)
        s.is_valid(raise_exception=True)
        username = s.validated_data["username"].strip()
        role = s.validated_data.get("role") or Role.MANAGER
        plain = s.validated_data.get("password") or generate_temp_password()
        reports_to_id = s.validated_data.get("reports_to_id")

        # Singleton guard for super_manager — ровно один в системе.
        # Validator is inside the service, but doing a pre-check here
        # gives нам chance to return 400 before DB side-effects.
        if role == Role.SUPER_MANAGER:
            actor = request.user
            actor_is_superadmin = bool(
                actor.is_superuser
                or (
                    getattr(getattr(actor, "profile", None), "role", None)
                    == Role.SUPERADMIN
                )
            )
            if not actor_is_superadmin:
                return Response(
                    {"detail": "Назначать super_manager может только superadmin"},
                    status=status.HTTP_403_FORBIDDEN,
                )
            if Profile.objects.filter(role=Role.SUPER_MANAGER).exists():
                return Response(
                    {
                        "detail": (
                            "Уже есть super_manager — снимите роль с него "
                            "сначала (должен быть ровно один)."
                        )
                    },
                    status=status.HTTP_400_BAD_REQUEST,
                )

        if User.objects.filter(username=username).exists():
            return Response(
                {"detail": "Пользователь с таким логином уже существует"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Resolve reports_to (optional). Caller may hand us an id of a
        # super_manager / superadmin — we don't validate hierarchy here
        # beyond "the user exists"; frontend filters the dropdown options.
        reports_to_user = None
        if reports_to_id:
            reports_to_user = User.objects.filter(pk=reports_to_id).first()
            if reports_to_user is None:
                return Response(
                    {"detail": "reports_to_id указывает на несуществующего пользователя"},
                    status=status.HTTP_400_BAD_REQUEST,
                )

        user = User.objects.create(username=username, is_active=True)
        user_password_set(user=user, plain=plain)
        Profile.objects.update_or_create(
            user=user,
            defaults={"role": role, "reports_to": reports_to_user},
        )
        audit_log_create(
            user=request.user,
            action=AuditAction.CREATE,
            entity="users.User",
            entity_id=user.id,
            changes={
                "username": username,
                "role": role,
                "reports_to_id": reports_to_id,
            },
        )
        return Response(
            {
                "id": user.id,
                "username": user.username,
                "role": role,
                "is_active": True,
                "password": plain,
                "reports_to_id": reports_to_id,
            },
            status=status.HTTP_201_CREATED,
        )


class UserResetPasswordApi(APIView):
    """POST /users/{id}/reset-password/"""

    permission_classes = [IsManager]

    def post(self, request, user_id: int):
        try:
            user = User.objects.get(pk=user_id)
        except User.DoesNotExist:
            raise NotFound("Пользователь не найден")
        if user.id == request.user.id:
            return Response(
                {"detail": "Смените свой пароль через /me/change-password/"},
                status=status.HTTP_400_BAD_REQUEST,
            )
        plain = generate_temp_password()
        user_password_set(user=user, plain=plain)
        audit_log_create(
            user=request.user,
            action=AuditAction.UPDATE,
            entity="users.User",
            entity_id=user.id,
            changes={"password_reset": True},
        )
        return Response({"id": user.id, "username": user.username, "password": plain})


class UserDeleteApi(APIView):
    """POST /users/{id}/delete/ — soft-delete (deactivate) or hard for su."""

    permission_classes = [IsManager]

    def post(self, request, user_id: int):
        try:
            user = User.objects.get(pk=user_id)
        except User.DoesNotExist:
            raise NotFound("Пользователь не найден")
        if user.id == request.user.id:
            return Response(
                {"detail": "Нельзя удалить самого себя"},
                status=status.HTTP_400_BAD_REQUEST,
            )
        user.is_active = False
        user.save(update_fields=["is_active"])
        audit_log_create(
            user=request.user,
            action=AuditAction.DELETE,
            entity="users.User",
            entity_id=user.id,
            changes={"deactivated_at": timezone.now().isoformat()},
        )
        return Response({"id": user.id, "is_active": False})


class UserUpdateApi(APIView):
    """
    PATCH /users/{id}/ — manager-only partial update.

    Supports:
      * `preferred_language` (RU/UZ) — used by the Users admin page so a
        manager can force an account's UI/AI language without needing the
        operator to log in and change it.
      * `role` — change the user's Role. Promoting to SUPER_MANAGER is
        superadmin-only + singleton (`profile_role_update` enforces both).
      * `profile.reports_to_id` / top-level `reports_to_id` — owner link
        for the 3-level hierarchy. Permission:
          - superadmin / superuser: free
          - super_manager: can only set reports_to=self on a manager they
            «claim» (role must be MANAGER after save).
    Every mutation is audit-logged.
    """

    permission_classes = [IsManager]

    class InputSerializer(serializers.Serializer):
        preferred_language = serializers.ChoiceField(
            choices=[("ru", "ru"), ("uz", "uz")],
            required=False,
        )
        role = serializers.ChoiceField(
            choices=[
                Role.MANAGER,
                Role.TEAM_LEAD,
                Role.SUPER_MANAGER,
                Role.OPERATOR,
                Role.SMM,
                Role.SUPERADMIN,
            ],
            required=False,
        )
        reports_to_id = serializers.IntegerField(
            required=False, allow_null=True,
        )

    def patch(self, request, user_id: int):
        try:
            user = User.objects.get(pk=user_id)
        except User.DoesNotExist:
            raise NotFound("Пользователь не найден")

        s = self.InputSerializer(data=request.data)
        s.is_valid(raise_exception=True)

        updated: dict = {}
        profile = None
        if "preferred_language" in s.validated_data:
            profile, _ = Profile.objects.get_or_create(user=user)
            old = profile.preferred_language
            new = s.validated_data["preferred_language"]
            if old != new:
                profile.preferred_language = new
                profile.save(update_fields=["preferred_language"])
                audit_log_create(
                    user=request.user,
                    action=AuditAction.UPDATE,
                    entity="users.Profile",
                    entity_id=profile.id,
                    changes={"preferred_language": {"old": old, "new": new}},
                )
            updated["preferred_language"] = new

        if "role" in s.validated_data:
            if profile is None:
                profile, _ = Profile.objects.get_or_create(user=user)
            new_role = s.validated_data["role"]
            # profile_role_update is the single enforcement point for the
            # super_manager singleton + superadmin-only promotion rule.
            profile = profile_role_update(
                profile=profile, new_role=new_role, actor=request.user,
            )
            updated["role"] = profile.role

        if "reports_to_id" in s.validated_data:
            if profile is None:
                profile, _ = Profile.objects.get_or_create(user=user)
            new_owner_id = s.validated_data["reports_to_id"]
            new_owner = None
            if new_owner_id is not None:
                new_owner = User.objects.filter(pk=new_owner_id).first()
                if new_owner is None:
                    return Response(
                        {"detail": "reports_to_id указывает на несуществующего пользователя"},
                        status=status.HTTP_400_BAD_REQUEST,
                    )

            # Hierarchy guard — see docstring. Superadmin / superuser:
            # free pass; super_manager: can only assign reports_to=self;
            # anyone else: 403.
            actor = request.user
            actor_profile = getattr(actor, "profile", None)
            actor_role = actor_profile.role if actor_profile else None
            if not (actor.is_superuser or actor_role == Role.SUPERADMIN):
                if actor_role == Role.SUPER_MANAGER:
                    if new_owner is not None and new_owner.id != actor.id:
                        return Response(
                            {"detail": "Super_manager может назначать reports_to только на себя"},
                            status=status.HTTP_403_FORBIDDEN,
                        )
                else:
                    return Response(
                        {"detail": "Недостаточно прав для изменения reports_to"},
                        status=status.HTTP_403_FORBIDDEN,
                    )

            old_owner_id = profile.reports_to_id
            if old_owner_id != (new_owner.id if new_owner else None):
                profile.reports_to = new_owner
                profile.save(update_fields=["reports_to"])
                audit_log_create(
                    user=request.user,
                    action=AuditAction.UPDATE,
                    entity="users.Profile",
                    entity_id=profile.id,
                    changes={
                        "reports_to_id": {
                            "old": old_owner_id,
                            "new": new_owner.id if new_owner else None,
                        },
                        "target_user_id": user.id,
                    },
                )
            updated["reports_to_id"] = new_owner.id if new_owner else None

        return Response({
            "id": user.id,
            "username": user.username,
            **updated,
        })


class OperatorAccountLanguageApi(APIView):
    """
    PATCH /operators/{id}/account/language/  {preferred_language: 'ru'|'uz'}

    Manager surface — set the linked operator user's language without
    touching passwords / activation. Keeps the operator-admin flow in
    one place (Operators page, not Users page).
    """

    permission_classes = [IsManager]

    class InputSerializer(serializers.Serializer):
        preferred_language = serializers.ChoiceField(choices=[("ru", "ru"), ("uz", "uz")])

    def patch(self, request, operator_id: int):
        operator = _operator_or_404(operator_id)
        user = user_by_operator(operator)
        if user is None:
            raise NotFound("У оператора нет аккаунта")

        s = self.InputSerializer(data=request.data)
        s.is_valid(raise_exception=True)

        profile, _ = Profile.objects.get_or_create(user=user)
        old = profile.preferred_language
        new = s.validated_data["preferred_language"]
        if old != new:
            profile.preferred_language = new
            profile.save(update_fields=["preferred_language"])
            audit_log_create(
                user=request.user,
                action=AuditAction.UPDATE,
                entity="users.Profile",
                entity_id=profile.id,
                changes={
                    "target_operator_id": operator.id,
                    "preferred_language": {"old": old, "new": new},
                },
            )
        return Response({
            "operator_id": operator.id,
            "user_id": user.id,
            "preferred_language": new,
        })

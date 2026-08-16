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
from .selectors import account_state, user_by_operator
from .services import (
    account_activate,
    account_create_for_operator,
    account_deactivate,
    account_reset_password,
    account_soft_delete,
    password_view,
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
        operator_name = profile.operator.full_name if profile and profile.operator else None
        display_name = operator_name or (user.get_full_name() or None)
        preferred_language = getattr(profile, "preferred_language", None) or "uz"
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
            }
        )

    def patch(self, request):
        """Self-service partial update — currently only `preferred_language`.

        Any authenticated user can flip their own language preference
        (used by operators when they want RU / UZ; managers may also
        set their own). Managers change other users' language through
        the dedicated admin endpoints below.
        """
        user = request.user
        profile = getattr(user, "profile", None)
        if profile is None:
            from .models import Profile as _Profile
            profile = _Profile.objects.create(user=user)

        lang = request.data.get("preferred_language")
        if lang not in ("ru", "uz"):
            return Response(
                {"preferred_language": "must be 'ru' or 'uz'"},
                status=status.HTTP_400_BAD_REQUEST,
            )
        profile.preferred_language = lang
        profile.save(update_fields=["preferred_language"])
        return Response({"preferred_language": profile.preferred_language})


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
            choices=[Role.MANAGER, Role.TEAM_LEAD, Role.SUPERADMIN],
            default=Role.MANAGER,
        )

    def get(self, request):
        # We only list web-only accounts (not operator-linked ones —
        # those are managed via /operators/{id}/account/…).
        rows = []
        for user in (
            User.objects.filter(is_active=True)
            .exclude(profile__operator__isnull=False)
            .select_related("profile")
            .order_by("username")
        ):
            profile = getattr(user, "profile", None)
            rows.append({
                "id": user.id,
                "username": user.username,
                "role": profile.role if profile else "team_lead",
                "is_active": user.is_active,
                "is_superuser": user.is_superuser,
                "date_joined": user.date_joined.isoformat() if user.date_joined else None,
                "last_login": user.last_login.isoformat() if user.last_login else None,
                "preferred_language": getattr(profile, "preferred_language", None) or "uz",
            })
        return Response(rows)

    def post(self, request):
        s = self.CreateSerializer(data=request.data)
        s.is_valid(raise_exception=True)
        username = s.validated_data["username"].strip()
        role = s.validated_data.get("role") or Role.MANAGER
        plain = s.validated_data.get("password") or generate_temp_password()

        if User.objects.filter(username=username).exists():
            return Response(
                {"detail": "Пользователь с таким логином уже существует"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        user = User.objects.create(username=username, is_active=True)
        user_password_set(user=user, plain=plain)
        Profile.objects.update_or_create(user=user, defaults={"role": role})
        audit_log_create(
            user=request.user,
            action=AuditAction.CREATE,
            entity="users.User",
            entity_id=user.id,
            changes={"username": username, "role": role},
        )
        return Response(
            {
                "id": user.id,
                "username": user.username,
                "role": role,
                "is_active": True,
                "password": plain,
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

    Currently supports only `preferred_language` (RU/UZ) — used by
    the Users admin page so a manager can force an account's UI/AI
    language without needing the operator to log in and change it.
    Audit-logged so the trail shows who flipped whose language.
    """

    permission_classes = [IsManager]

    class InputSerializer(serializers.Serializer):
        preferred_language = serializers.ChoiceField(
            choices=[("ru", "ru"), ("uz", "uz")],
            required=False,
        )

    def patch(self, request, user_id: int):
        try:
            user = User.objects.get(pk=user_id)
        except User.DoesNotExist:
            raise NotFound("Пользователь не найден")

        s = self.InputSerializer(data=request.data)
        s.is_valid(raise_exception=True)

        updated: dict = {}
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

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
        return Response(
            {
                "username": user.username,
                "role": profile.role if profile else "team_lead",
                "is_superuser": user.is_superuser,
                "operator_id": profile.operator_id if profile else None,
                "operator_name": profile.operator.full_name if profile and profile.operator else None,
                "telegram_user_id": profile.telegram_user_id if profile else None,
            }
        )


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

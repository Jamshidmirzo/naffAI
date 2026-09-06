"""
Thin DRF views for the Flutter mobile app.

Auth: JWT via `rest_framework_simplejwt`. Web CRM keeps using
Session+Token auth — both authentication classes are enabled globally
and DRF picks the one the request presents.

Grouping:
  - `MobileLoginApi`, `MobileRefreshApi` → /api/auth/mobile-*
  - `MobileMeApi`, `MobileMyLeadsApi`, `MobileLeadDetailApi`,
    `MobileLeadStatusApi` → /api/mobile/*
"""

from __future__ import annotations

from django.contrib.auth import authenticate, get_user_model
from rest_framework import serializers, status
from rest_framework.exceptions import NotFound
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.throttling import AnonRateThrottle
from rest_framework.views import APIView
from rest_framework_simplejwt.exceptions import InvalidToken, TokenError
from rest_framework_simplejwt.tokens import RefreshToken

from apps.calls.selectors import call_attempts_for_lead
from apps.common.exceptions import ApplicationError
from apps.common.validators import normalize_uz_phone
from apps.leads.selectors import lead_get
from apps.leads.services import lead_update_status
from apps.users.permissions import IsOperator

from .selectors import mobile_leads_for_operator_page, mobile_me_payload
from .serializers import (
    MobileCallAttemptSerializer,
    MobileLeadSerializer,
    MobileLeadStatusInputSerializer,
    MobileMeSerializer,
)

User = get_user_model()


# ---------------------------------------------------------------------------
# Auth — mobile JWT surface
# ---------------------------------------------------------------------------


class MobileLoginRateThrottle(AnonRateThrottle):
    scope = "login"


class MobileLoginApi(APIView):
    """
    POST /api/auth/mobile-login/  {phone, password}

    Accepts either a full +998 phone (preferred — operators log in by
    phone) or a raw username (backwards compatible with the web login).
    Returns a JWT pair + a compact operator payload so the app can render
    the home screen without a second /me/ round-trip.
    """

    permission_classes = [AllowAny]
    authentication_classes = []  # bypass session/CSRF for API clients
    throttle_classes = [MobileLoginRateThrottle]

    class InputSerializer(serializers.Serializer):
        phone = serializers.CharField()
        password = serializers.CharField()

    def post(self, request):
        s = self.InputSerializer(data=request.data)
        s.is_valid(raise_exception=True)
        raw = s.validated_data["phone"]
        password = s.validated_data["password"]

        normalized, valid = normalize_uz_phone(raw)
        candidates = [raw]
        if valid and normalized != raw:
            candidates.insert(0, normalized)

        user = None
        for candidate in candidates:
            user = authenticate(username=candidate, password=password)
            if user:
                break
        if not user or not user.is_active:
            return Response(
                {"detail": "Неверный логин или пароль"},
                status=status.HTTP_401_UNAUTHORIZED,
            )

        refresh = RefreshToken.for_user(user)
        payload = mobile_me_payload(user)
        return Response(
            {
                "access": str(refresh.access_token),
                "refresh": str(refresh),
                **MobileMeSerializer(payload).data,
            }
        )


class MobileRefreshApi(APIView):
    """
    POST /api/auth/mobile-refresh/  {refresh}

    Wraps SimpleJWT's TokenRefreshView but as an explicit APIView so we
    can uniform-error the mobile client (401 instead of DRF's default 400).
    """

    permission_classes = [AllowAny]
    authentication_classes = []
    throttle_classes = [MobileLoginRateThrottle]

    class InputSerializer(serializers.Serializer):
        refresh = serializers.CharField()

    def post(self, request):
        s = self.InputSerializer(data=request.data)
        s.is_valid(raise_exception=True)
        try:
            refresh = RefreshToken(s.validated_data["refresh"])
            access = str(refresh.access_token)
        except (TokenError, InvalidToken):
            return Response(
                {"detail": "Refresh token invalid or expired"},
                status=status.HTTP_401_UNAUTHORIZED,
            )
        return Response({"access": access})


# ---------------------------------------------------------------------------
# Mobile domain endpoints — /api/mobile/*
# ---------------------------------------------------------------------------


class MobileMeApi(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        payload = mobile_me_payload(request.user)
        return Response(MobileMeSerializer(payload).data)


class MobileMyLeadsApi(APIView):
    """
    GET /api/mobile/leads/my/?limit=50&cursor=<id>&view=active

    Returns a compact page of leads assigned to the logged-in operator.
    Managers/team-leads pass the permission check too but see an empty
    list — the endpoint is scoped to the caller's own Operator FK, which
    they lack. This is intentional: managers use the web CRM.
    """

    permission_classes = [IsOperator]

    def get(self, request):
        profile = getattr(request.user, "profile", None)
        operator = profile.operator if profile and profile.operator_id else None
        if operator is None:
            return Response({"results": [], "next_cursor": None})

        try:
            limit = int(request.query_params.get("limit") or 50)
        except (TypeError, ValueError):
            limit = 50
        raw_cursor = request.query_params.get("cursor")
        cursor: int | None
        try:
            cursor = int(raw_cursor) if raw_cursor else None
        except (TypeError, ValueError):
            cursor = None
        view = request.query_params.get("view") or "active"
        if view not in {"active", "postponed", "closed", "all"}:
            view = "active"

        rows, next_cursor = mobile_leads_for_operator_page(
            operator=operator, cursor=cursor, limit=limit, view=view
        )
        return Response(
            {
                "results": MobileLeadSerializer(rows, many=True).data,
                "next_cursor": next_cursor,
            }
        )


class MobileLeadDetailApi(APIView):
    """
    GET /api/mobile/leads/{id}/ — lead payload + last 20 call attempts.
    """

    permission_classes = [IsOperator]

    def get(self, request, pk: int):
        lead = lead_get(pk)
        if not lead:
            raise NotFound("Лид не найден")

        # Operators may only see their own leads. Seniors see everything.
        profile = getattr(request.user, "profile", None)
        from apps.users.models import Role

        role = profile.role if profile else None
        if role == Role.OPERATOR:
            if not profile or lead.operator_id != profile.operator_id:
                return Response({"detail": "Нет доступа"}, status=status.HTTP_403_FORBIDDEN)

        calls_qs = call_attempts_for_lead(lead.id)[:20]
        return Response(
            {
                "lead": MobileLeadSerializer(lead).data,
                "calls": MobileCallAttemptSerializer(calls_qs, many=True).data,
            }
        )


class MobileLeadStatusApi(APIView):
    """
    PATCH /api/mobile/leads/{id}/status/  {status, comment?}
    """

    permission_classes = [IsOperator]

    def patch(self, request, pk: int):
        lead = lead_get(pk)
        if not lead:
            raise NotFound("Лид не найден")

        profile = getattr(request.user, "profile", None)
        from apps.users.models import Role

        role = profile.role if profile else None
        if role == Role.OPERATOR:
            if not profile or lead.operator_id != profile.operator_id:
                return Response({"detail": "Нет доступа"}, status=status.HTTP_403_FORBIDDEN)

        s = MobileLeadStatusInputSerializer(data=request.data)
        s.is_valid(raise_exception=True)
        try:
            lead_update_status(
                lead=lead,
                status=s.validated_data["status"],
                user=request.user,
                comment=s.validated_data.get("comment", ""),
            )
        except ApplicationError as exc:
            return Response({"detail": exc.message, **exc.extra}, status=400)
        return Response(MobileLeadSerializer(lead).data)

"""
DRF views для attendance-PIN-gate. Views тонкие — вся логика в
`pin_services`.

Endpoints:
- `GET  /api/attendance/pin/status/` — статус PIN'a текущего пользователя.
- `POST /api/attendance/pin/set/` — задать/сменить PIN.
- `POST /api/attendance/pin/verify/` — подтвердить PIN, открыть 30-мин
  сессию.
- `POST /api/attendance/pin/reset/<profile_id>/` — сбросить PIN у
  указанного менеджера (только superadmin).
"""

from __future__ import annotations

from django.contrib.auth import get_user_model
from django.shortcuts import get_object_or_404
from rest_framework import serializers, status
from rest_framework.exceptions import NotFound, PermissionDenied
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.users.models import Profile, Role
from apps.users.permissions import _role, SENIOR_ROLES

from .pin_services import (
    PIN_TTL,
    attendance_pin_reset,
    attendance_pin_session_expires_at,
    attendance_pin_session_is_valid,
    attendance_pin_set,
    attendance_pin_verify,
)

User = get_user_model()


class PinStatusApi(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        user = request.user
        role = _role(user) or ""
        profile = getattr(user, "profile", None)
        has_pin = bool(profile and profile.attendance_pin_hash)

        if role == Role.SUPERADMIN:
            # Superadmin PIN не требуется — фронт по флагу render'ит
            # children сразу.
            return Response({
                "role": role,
                "has_pin": has_pin,
                "pin_required": False,
                "pin_verified": True,
                "expires_at": None,
                "ttl_minutes": int(PIN_TTL.total_seconds() // 60),
            })

        # Не senior — PIN не нужен; вьюхи всё равно отдадут 403 через
        # IsTeamLeadOrManager, но статус-эндпоинт открытый, отдаём мета.
        if role not in SENIOR_ROLES:
            return Response({
                "role": role,
                "has_pin": False,
                "pin_required": False,
                "pin_verified": False,
                "expires_at": None,
                "ttl_minutes": int(PIN_TTL.total_seconds() // 60),
            })

        verified = has_pin and attendance_pin_session_is_valid(user)
        expires_at = attendance_pin_session_expires_at(user) if verified else None
        return Response({
            "role": role,
            "has_pin": has_pin,
            "pin_required": True,
            "pin_verified": verified,
            "expires_at": expires_at.isoformat() if expires_at else None,
            "ttl_minutes": int(PIN_TTL.total_seconds() // 60),
        })


class PinSetApi(APIView):
    permission_classes = [IsAuthenticated]

    class InputSerializer(serializers.Serializer):
        new_pin = serializers.CharField()
        old_pin = serializers.CharField(required=False, allow_blank=True)

    def post(self, request):
        role = _role(request.user)
        # Ставить PIN может любой senior (включая superadmin — пусть
        # хочет — но по факту фронт даже не показывает форму superadmin'y).
        if role not in SENIOR_ROLES:
            raise PermissionDenied("Только для менеджеров")

        s = self.InputSerializer(data=request.data)
        s.is_valid(raise_exception=True)
        attendance_pin_set(
            user=request.user,
            new_pin=s.validated_data["new_pin"],
            old_pin=s.validated_data.get("old_pin") or None,
        )
        return Response({"ok": True}, status=status.HTTP_200_OK)


class PinVerifyApi(APIView):
    permission_classes = [IsAuthenticated]

    class InputSerializer(serializers.Serializer):
        pin = serializers.CharField()

    def post(self, request):
        role = _role(request.user)
        # Superadmin verify не нужен — но чтобы фронт мог общий поток
        # использовать, отвечаем 200 с фиктивной сессией.
        if role == Role.SUPERADMIN:
            return Response({
                "ok": True,
                "expires_at": None,
                "role": role,
            })

        if role not in SENIOR_ROLES:
            raise PermissionDenied("Только для менеджеров")

        s = self.InputSerializer(data=request.data)
        s.is_valid(raise_exception=True)
        session = attendance_pin_verify(user=request.user, pin=s.validated_data["pin"])
        return Response({
            "ok": True,
            "expires_at": (session.verified_at + PIN_TTL).isoformat(),
            "role": role,
        })


class PinResetApi(APIView):
    """
    POST /api/attendance/pin/reset/<profile_id>/ — только superadmin.

    Сбрасывает PIN у менеджера с `Profile.pk == profile_id`. Мы передаём
    именно profile_id (а не user_id), потому что во фронте страница
    пользователей рисует список user'ов, но привязка PIN'a живёт на
    Profile — упрощает клиентский код (может отправить или тот, или
    другой, приводим к User внутри).
    """

    permission_classes = [IsAuthenticated]

    def post(self, request, profile_id: int):
        if _role(request.user) != Role.SUPERADMIN:
            raise PermissionDenied("Сброс PIN разрешён только супер-админу")

        # Пытаемся сначала как Profile.pk (родная семантика), затем как
        # User.pk — на случай если фронт передал user.id.
        try:
            profile = Profile.objects.select_related("user").get(pk=profile_id)
        except Profile.DoesNotExist:
            profile = None

        if profile is None:
            user = get_object_or_404(User, pk=profile_id)
            profile = Profile.objects.select_related("user").filter(user=user).first()
            if profile is None:
                raise NotFound("Профиль не найден")

        target_user = profile.user
        if _role(target_user) not in SENIOR_ROLES:
            raise PermissionDenied("Сбрасывать PIN можно только у менеджеров")

        attendance_pin_reset(actor=request.user, target=target_user)
        return Response({"ok": True, "profile_id": profile.pk, "user_id": target_user.id})

"""
DRF views для attendance-PIN-gate. Views тонкие — вся логика в
`pin_services`.

PIN — глобальный, один на всех менеджеров. Только superadmin может
установить/сбросить.

Endpoints:
- `GET  /api/attendance/pin/status/` — статус глобального PIN'a +
  personal-session текущего пользователя.
- `POST /api/attendance/pin/set/` — установить/сменить глобальный PIN
  (только superadmin).
- `POST /api/attendance/pin/verify/` — подтвердить PIN, открыть 30-мин
  personal-сессию.
- `POST /api/attendance/pin/reset/` — сбросить глобальный PIN
  (только superadmin, инвалидирует все personal-сессии).
"""

from __future__ import annotations

from django.contrib.auth import get_user_model
from rest_framework import serializers, status
from rest_framework.exceptions import PermissionDenied
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.users.models import Role
from apps.users.permissions import _role, SENIOR_ROLES

from .pin_services import (
    PIN_TTL,
    attendance_pin_meta,
    attendance_pin_reset,
    attendance_pin_session_expires_at,
    attendance_pin_session_is_valid,
    attendance_pin_set,
    attendance_pin_verify,
)

User = get_user_model()


def _is_superadmin(user) -> bool:
    return _role(user) == Role.SUPERADMIN


class PinStatusApi(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        user = request.user
        role = _role(user) or ""
        meta = attendance_pin_meta()
        has_pin = meta["has_pin"]

        # Superadmin: PIN не требуется, но статус глобального PIN'a ему
        # нужен, чтобы страница настроек показала «задать» vs «сменить».
        if role == Role.SUPERADMIN:
            return Response({
                "role": role,
                "has_pin": has_pin,
                "pin_required": False,
                "pin_verified": True,
                "expires_at": None,
                "ttl_minutes": int(PIN_TTL.total_seconds() // 60),
                "updated_at": meta["updated_at"],
                "updated_by": meta["updated_by"],
            })

        # Не senior — endpoint открытый, но никакой информации о PIN'e
        # не отдаём (только флаги, чтобы фронт мог понять что делать).
        if role not in SENIOR_ROLES:
            return Response({
                "role": role,
                "has_pin": False,
                "pin_required": False,
                "pin_verified": False,
                "expires_at": None,
                "ttl_minutes": int(PIN_TTL.total_seconds() // 60),
                "updated_at": None,
                "updated_by": None,
            })

        # Менеджер / тимлид — PIN нужен всегда.
        verified = has_pin and attendance_pin_session_is_valid(user)
        expires_at = attendance_pin_session_expires_at(user) if verified else None
        return Response({
            "role": role,
            "has_pin": has_pin,
            "pin_required": True,
            "pin_verified": verified,
            "expires_at": expires_at.isoformat() if expires_at else None,
            "ttl_minutes": int(PIN_TTL.total_seconds() // 60),
            "updated_at": meta["updated_at"],
            "updated_by": meta["updated_by"],
        })


class PinSetApi(APIView):
    """POST /api/attendance/pin/set/ — только superadmin.

    Body: `{"new_pin": "1234"}`. `old_pin` не требуется — суперадмин
    имеет право менять всегда, а в UI у него PIN'a нет вовсе.
    """

    permission_classes = [IsAuthenticated]

    class InputSerializer(serializers.Serializer):
        new_pin = serializers.CharField()

    def post(self, request):
        if not _is_superadmin(request.user):
            raise PermissionDenied("Устанавливать общий PIN может только супер-админ")

        s = self.InputSerializer(data=request.data)
        s.is_valid(raise_exception=True)
        attendance_pin_set(actor=request.user, new_pin=s.validated_data["new_pin"])
        return Response({"ok": True}, status=status.HTTP_200_OK)


class PinVerifyApi(APIView):
    """POST /api/attendance/pin/verify/ — любой senior.

    Manager/team-lead вводит общий PIN; при успехе открываем 30-мин
    personal-сессию. Superadmin: возвращаем 200 без сессии, чтобы фронт
    мог общий поток использовать.
    """

    permission_classes = [IsAuthenticated]

    class InputSerializer(serializers.Serializer):
        pin = serializers.CharField()

    def post(self, request):
        role = _role(request.user)
        if role == Role.SUPERADMIN:
            return Response({"ok": True, "expires_at": None, "role": role})

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
    """POST /api/attendance/pin/reset/ — только superadmin.

    Body: пустой. Сбрасывает глобальный `AttendanceSettings.pin_hash`
    и удаляет ВСЕ `AttendancePinSession` — после reset никто не
    сможет войти в attendance-раздел, пока superadmin не задаст новый.
    """

    permission_classes = [IsAuthenticated]

    def post(self, request):
        if not _is_superadmin(request.user):
            raise PermissionDenied("Сбрасывать общий PIN может только супер-админ")
        attendance_pin_reset(actor=request.user)
        return Response({"ok": True})

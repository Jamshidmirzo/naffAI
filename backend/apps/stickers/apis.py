"""
Sticker HTTP surface. Thin views — all logic lives in services/selectors.

- ``GET  /api/stickers/palette/``     Return the whole palette + who owns
                                     each regular emoji + the current rare.
- ``PUT  /api/me/sticker/``           Operator picks their regular sticker.
- ``PUT  /api/operators/{pk}/sticker/`` Admin sets any operator's sticker.
                                     If body has ``is_rare=true``, grants
                                     the rare (revoking any previous
                                     holder). Otherwise sets a regular.
- ``DELETE /api/operators/{pk}/sticker/`` Admin revokes an operator's
                                     sticker.
"""

from __future__ import annotations

from rest_framework import serializers
from rest_framework.exceptions import ValidationError
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.operators.selectors import operator_get
from apps.users.models import Role
from apps.users.permissions import IsTeamLeadOrManagerReadOnly  # noqa: F401


class IsTeamLeadOrManager(IsTeamLeadOrManagerReadOnly):
    """team_lead / manager (both write). Superuser also passes."""

    def has_permission(self, request, view) -> bool:
        user = request.user
        if not user or not user.is_authenticated:
            return False
        if user.is_superuser:
            return True
        profile = getattr(user, "profile", None)
        role = profile.role if profile else None
        return role in {Role.TEAM_LEAD, Role.MANAGER, Role.SUPERADMIN}

from .selectors import rare_holder, sticker_for, taken_emojis
from .services import (
    ALLOWED_COMMON_EMOJIS,
    sticker_grant_rare,
    sticker_revoke,
    sticker_set,
)


class StickerPayloadSerializer(serializers.Serializer):
    emoji = serializers.CharField(max_length=8)
    is_rare = serializers.BooleanField(required=False, default=False)


def _serialize_sticker(sticker) -> dict | None:
    if sticker is None:
        return None
    return {
        "emoji": sticker.emoji,
        "is_rare": sticker.is_rare,
        "operator_id": sticker.operator_id,
    }


class StickerPaletteApi(APIView):
    """List of all palette emojis + who took what, plus the rare holder."""

    permission_classes = [IsAuthenticated]

    def get(self, request):
        taken = taken_emojis()
        rare = rare_holder()
        return Response({
            "palette": list(ALLOWED_COMMON_EMOJIS),
            "taken": [
                {"emoji": emoji, "operator_name": name}
                for emoji, name in taken.items()
            ],
            "rare": (
                {
                    "emoji": rare.emoji,
                    "operator_id": rare.operator_id,
                    "operator_name": rare.operator.full_name,
                }
                if rare
                else None
            ),
        })


class MySelfStickerApi(APIView):
    """Operator claims/updates their own regular sticker."""

    permission_classes = [IsAuthenticated]

    def put(self, request):
        profile = getattr(request.user, "profile", None)
        operator = getattr(profile, "operator", None) if profile else None
        if operator is None:
            raise ValidationError("У этого пользователя нет привязанного оператора.")
        payload = StickerPayloadSerializer(data=request.data)
        payload.is_valid(raise_exception=True)
        sticker = sticker_set(
            operator=operator,
            emoji=payload.validated_data["emoji"],
            actor=request.user,
        )
        return Response(_serialize_sticker(sticker))

    def get(self, request):
        profile = getattr(request.user, "profile", None)
        operator = getattr(profile, "operator", None) if profile else None
        if operator is None:
            return Response({"sticker": None})
        return Response({"sticker": _serialize_sticker(sticker_for(operator))})

    def delete(self, request):
        profile = getattr(request.user, "profile", None)
        operator = getattr(profile, "operator", None) if profile else None
        if operator is None:
            raise ValidationError("У этого пользователя нет привязанного оператора.")
        sticker_revoke(operator=operator, actor=request.user)
        return Response(status=204)


class OperatorStickerApi(APIView):
    """
    Admin surface — team_lead/manager sets/revokes any operator's sticker.
    """

    permission_classes = [IsTeamLeadOrManager]

    def get(self, request, pk: int):
        op = operator_get(pk)
        if op is None:
            return Response({"detail": "Not found"}, status=404)
        return Response({"sticker": _serialize_sticker(sticker_for(op))})

    def put(self, request, pk: int):
        op = operator_get(pk)
        if op is None:
            return Response({"detail": "Not found"}, status=404)
        payload = StickerPayloadSerializer(data=request.data)
        payload.is_valid(raise_exception=True)
        emoji = payload.validated_data["emoji"]
        is_rare = payload.validated_data.get("is_rare", False)
        if is_rare:
            sticker = sticker_grant_rare(operator=op, emoji=emoji, actor=request.user)
        else:
            sticker = sticker_set(operator=op, emoji=emoji, actor=request.user)
        return Response(_serialize_sticker(sticker))

    def delete(self, request, pk: int):
        op = operator_get(pk)
        if op is None:
            return Response({"detail": "Not found"}, status=404)
        sticker_revoke(operator=op, actor=request.user)
        return Response(status=204)

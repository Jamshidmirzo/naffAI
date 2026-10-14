"""Thin DRF views for in-app notifications."""

from rest_framework import serializers, status
from rest_framework.generics import ListAPIView
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.users.permissions import IsAuthenticatedAnyRole

from .models import Notification
from .selectors import (
    notification_preferences_for_user,
    notifications_for_user,
    unread_count_for_user,
)
from .services import (
    notification_mark_all_read,
    notification_mark_read,
    notification_preferences_update,
)


class NotificationSerializer(serializers.ModelSerializer):
    class Meta:
        model = Notification
        fields = [
            "id",
            "kind",
            "title",
            "body",
            "link",
            "read_at",
            "metadata",
            "created_at",
        ]
        read_only_fields = fields


class NotificationListApi(ListAPIView):
    permission_classes = [IsAuthenticated, IsAuthenticatedAnyRole]
    serializer_class = NotificationSerializer

    def get_queryset(self):
        only_unread = self.request.query_params.get("unread") in ("1", "true", "True")
        kind = self.request.query_params.get("kind") or None
        return notifications_for_user(
            user_id=self.request.user.id, only_unread=only_unread, kind=kind
        )

    def list(self, request, *args, **kwargs):
        response = super().list(request, *args, **kwargs)
        # Attach unread total in the response envelope so the frontend
        # can render the sidebar badge without a second request.
        response.data["unread_count"] = unread_count_for_user(user_id=request.user.id)
        return response


class NotificationUnreadCountApi(APIView):
    permission_classes = [IsAuthenticated, IsAuthenticatedAnyRole]

    def get(self, request):
        return Response({"unread_count": unread_count_for_user(user_id=request.user.id)})


class MarkReadInputSerializer(serializers.Serializer):
    ids = serializers.ListField(child=serializers.IntegerField(), min_length=1)


class NotificationMarkReadApi(APIView):
    permission_classes = [IsAuthenticated, IsAuthenticatedAnyRole]

    def post(self, request):
        ser = MarkReadInputSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        marked = notification_mark_read(
            user_id=request.user.id, notification_ids=ser.validated_data["ids"]
        )
        return Response({"marked": marked}, status=status.HTTP_200_OK)


class NotificationMarkAllReadApi(APIView):
    permission_classes = [IsAuthenticated, IsAuthenticatedAnyRole]

    def post(self, request):
        marked = notification_mark_all_read(user_id=request.user.id)
        return Response({"marked": marked}, status=status.HTTP_200_OK)


class NotificationPreferenceItemSerializer(serializers.Serializer):
    kind = serializers.CharField(max_length=32)
    in_app = serializers.BooleanField(required=False)
    telegram = serializers.BooleanField(required=False)


class NotificationPreferencesInputSerializer(serializers.Serializer):
    items = NotificationPreferenceItemSerializer(many=True, allow_empty=True)


class NotificationPreferencesApi(APIView):
    """
    GET   /api/notifications/preferences/
      → {"items": [{"kind": "sale_created", "in_app": true, "telegram": false}, ...]}
    PATCH /api/notifications/preferences/  {"items": [{"kind": "...", "in_app": false}]}
      → тот же формат (полный список после изменения).

    Список kind'ов зависит от роли (senior vs operator); kind вне списка
    роли в PATCH → 400.
    """

    permission_classes = [IsAuthenticated, IsAuthenticatedAnyRole]

    def get(self, request):
        return Response({"items": notification_preferences_for_user(request.user)})

    def patch(self, request):
        ser = NotificationPreferencesInputSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        try:
            notification_preferences_update(
                user=request.user, items=ser.validated_data["items"]
            )
        except ValueError as exc:
            return Response(
                {"items": [f"Недопустимый kind для вашей роли: {exc}"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        return Response({"items": notification_preferences_for_user(request.user)})

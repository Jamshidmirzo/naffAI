from rest_framework import serializers
from rest_framework.generics import ListAPIView

from apps.users.permissions import IsTeamLeadOrManagerReadOnly

from .models import AuditLog
from .selectors import audit_log_list


class AuditLogSerializer(serializers.ModelSerializer):
    user_name = serializers.CharField(source="user.username", read_only=True, default=None)

    class Meta:
        model = AuditLog
        fields = [
            "id",
            "user",
            "user_name",
            "action",
            "entity",
            "entity_id",
            "changes",
            "comment",
            "created_at",
        ]


class AuditLogListApi(ListAPIView):
    permission_classes = [IsTeamLeadOrManagerReadOnly]
    serializer_class = AuditLogSerializer

    def get_queryset(self):
        return audit_log_list(
            entity=self.request.query_params.get("entity"),
            entity_id=self.request.query_params.get("entity_id"),
        )

"""
Mobile-app-facing serializers.

Kept intentionally compact: the Flutter client is on a phone screen and
low-bandwidth cellular, so we ship only the fields that render in the UI
or drive routing. All timestamps are ISO-8601 (Django default) which is
already timezone-aware because `USE_TZ = True`.
"""

from __future__ import annotations

from rest_framework import serializers

from apps.calls.models import CallAttempt
from apps.leads.models import Lead
from apps.operators.models import Operator


class MobileOperatorBriefSerializer(serializers.ModelSerializer):
    """Nested inside login/me responses — never returns SIP secrets."""

    class Meta:
        model = Operator
        fields = ["id", "full_name", "phone", "status"]


class MobileMeSerializer(serializers.Serializer):
    """
    Response shape for GET /api/mobile/me/.

    Not a ModelSerializer because we mix user, operator and metrics into a
    single flat payload — see `apps.mobile.selectors.mobile_me_payload`.
    """

    user_id = serializers.IntegerField()
    username = serializers.CharField()
    role = serializers.CharField()
    operator = MobileOperatorBriefSerializer(allow_null=True)
    preferred_language = serializers.CharField()
    metrics_today = serializers.DictField()
    sip_credentials = serializers.DictField(allow_null=True)


class MobileLeadSerializer(serializers.ModelSerializer):
    """Compact lead card — no assignments/audit noise."""

    operator_name = serializers.CharField(source="operator.full_name", read_only=True, default="")

    class Meta:
        model = Lead
        fields = [
            "id",
            "full_name",
            "phone",
            "phone_alt",
            "product_hint",
            "has_card",
            "status",
            "source",
            "operator",
            "operator_name",
            "postponed_at",
            "postpone_reason",
            "created_at",
            "updated_at",
        ]
        read_only_fields = fields


class MobileCallAttemptSerializer(serializers.ModelSerializer):
    class Meta:
        model = CallAttempt
        fields = [
            "id",
            "outcome",
            "comment",
            "phone_number",
            "started_at",
            "answered_at",
            "ended_at",
            "duration_seconds",
            "source",
            "created_at",
        ]
        read_only_fields = fields


class MobileLeadStatusInputSerializer(serializers.Serializer):
    status = serializers.CharField(max_length=64)
    comment = serializers.CharField(required=False, allow_blank=True, default="")

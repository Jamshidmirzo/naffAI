"""
Thin DRF views for call attempts and callback reminders.

Endpoints:
  POST /api/leads/<pk>/call-attempts/     — log a call outcome
  POST /api/leads/<pk>/callbacks/         — schedule a reminder
  GET  /api/callbacks/mine/due/           — used by the operator watcher hook
  GET  /api/callbacks/mine/               — full list for the operator
  POST /api/callbacks/<pk>/done/          — mark reminder complete
  POST /api/callbacks/<pk>/snooze/        — snooze reminder by N minutes
"""

from __future__ import annotations

from django.utils.dateparse import parse_datetime
from rest_framework import serializers, status
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.common.exceptions import ApplicationError
from apps.leads.selectors import lead_get
from apps.operators.models import Operator
from apps.users.permissions import IsAuthenticatedAnyRole, IsOperator, IsTeamLead

from .models import CallAttempt, CallbackReminder, CallOutcome
from .selectors import (
    callback_get,
    callbacks_due_soon_for_operator,
    callbacks_for_operator,
    call_attempts_for_lead,
)
from .services import (
    call_attempt_log,
    callback_reminder_complete,
    callback_reminder_create,
    callback_reminder_snooze,
)


# ---- Serializers ---------------------------------------------------------


class CallAttemptSerializer(serializers.ModelSerializer):
    operator_name = serializers.CharField(source="operator.full_name", read_only=True)

    class Meta:
        model = CallAttempt
        fields = ["id", "lead", "operator", "operator_name", "outcome", "comment", "created_at"]
        read_only_fields = ["id", "operator_name", "created_at"]


class CallAttemptInputSerializer(serializers.Serializer):
    outcome = serializers.ChoiceField(choices=CallOutcome.choices)
    comment = serializers.CharField(required=False, allow_blank=True, default="")
    operator_id = serializers.IntegerField(required=False)
    callback_remind_at = serializers.DateTimeField(required=False)
    callback_comment = serializers.CharField(required=False, allow_blank=True, default="")


class CallbackReminderSerializer(serializers.ModelSerializer):
    lead_name = serializers.CharField(source="lead.full_name", read_only=True)
    lead_phone = serializers.CharField(source="lead.phone", read_only=True)
    operator_name = serializers.CharField(source="operator.full_name", read_only=True)

    class Meta:
        model = CallbackReminder
        fields = [
            "id",
            "lead",
            "lead_name",
            "lead_phone",
            "operator",
            "operator_name",
            "remind_at",
            "status",
            "comment",
            "done_at",
            "created_at",
        ]
        read_only_fields = fields


class CallbackReminderInputSerializer(serializers.Serializer):
    remind_at = serializers.DateTimeField()
    comment = serializers.CharField(required=False, allow_blank=True, default="")
    operator_id = serializers.IntegerField(required=False)


class SnoozeInputSerializer(serializers.Serializer):
    minutes = serializers.IntegerField(min_value=1, max_value=60 * 24)


# ---- helpers -------------------------------------------------------------


def _operator_for_request(request) -> Operator | None:
    """
    Team-lead / admin can pass `operator_id` explicitly; otherwise fall
    back to `Profile.operator_id`. Returns None if neither works.
    """
    body = request.data or {}
    op_id = body.get("operator_id") if isinstance(body, dict) else None
    if op_id is None:
        profile = getattr(request.user, "profile", None)
        op_id = profile.operator_id if profile else None
    if not op_id:
        return None
    return Operator.objects.filter(pk=op_id).first()


# ---- Views ---------------------------------------------------------------


class LeadCallAttemptCreateApi(APIView):
    permission_classes = [IsAuthenticatedAnyRole]

    def get(self, request, pk: int):
        lead = lead_get(pk)
        if not lead:
            return Response({"detail": "Не найден"}, status=404)
        return Response(
            CallAttemptSerializer(call_attempts_for_lead(lead.id), many=True).data
        )

    def post(self, request, pk: int):
        lead = lead_get(pk)
        if not lead:
            return Response({"detail": "Не найден"}, status=404)
        ser = CallAttemptInputSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        v = ser.validated_data
        op = _operator_for_request(request)
        if op is None and v.get("operator_id"):
            op = Operator.objects.filter(pk=v["operator_id"]).first()
        if op is None:
            return Response({"detail": "Не указан оператор"}, status=400)
        try:
            attempt = call_attempt_log(
                user=request.user,
                lead=lead,
                operator=op,
                outcome=v["outcome"],
                comment=v.get("comment", ""),
                callback_remind_at=v.get("callback_remind_at"),
                callback_comment=v.get("callback_comment", ""),
            )
        except ApplicationError as exc:
            return Response({"detail": exc.message, **exc.extra}, status=400)
        return Response(CallAttemptSerializer(attempt).data, status=status.HTTP_201_CREATED)


class LeadCallbackCreateApi(APIView):
    permission_classes = [IsAuthenticatedAnyRole]

    def post(self, request, pk: int):
        lead = lead_get(pk)
        if not lead:
            return Response({"detail": "Не найден"}, status=404)
        ser = CallbackReminderInputSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        op = _operator_for_request(request)
        if op is None:
            return Response({"detail": "Не указан оператор"}, status=400)
        try:
            cb = callback_reminder_create(
                user=request.user,
                lead=lead,
                operator=op,
                remind_at=ser.validated_data["remind_at"],
                comment=ser.validated_data.get("comment", ""),
            )
        except ApplicationError as exc:
            return Response({"detail": exc.message, **exc.extra}, status=400)
        return Response(
            CallbackReminderSerializer(cb).data, status=status.HTTP_201_CREATED
        )


class CallbackMineListApi(APIView):
    permission_classes = [IsOperator]

    def get(self, request):
        profile = getattr(request.user, "profile", None)
        if not profile or not profile.operator_id:
            return Response({"detail": "У пользователя не привязан оператор"}, status=400)
        op = Operator.objects.filter(pk=profile.operator_id).first()
        if not op:
            return Response({"detail": "Оператор не найден"}, status=404)
        include_done = request.query_params.get("include_done") in ("1", "true")
        qs = callbacks_for_operator(op, include_done=include_done)
        return Response(CallbackReminderSerializer(qs, many=True).data)


class CallbackMineDueApi(APIView):
    """
    Used by the front-end useCallbackWatcher hook — poll every ~30s.
    Query param `window` (seconds) defaults to 60.
    """

    permission_classes = [IsOperator]

    def get(self, request):
        profile = getattr(request.user, "profile", None)
        if not profile or not profile.operator_id:
            return Response({"detail": "У пользователя не привязан оператор"}, status=400)
        op = Operator.objects.filter(pk=profile.operator_id).first()
        if not op:
            return Response({"detail": "Оператор не найден"}, status=404)
        try:
            window = max(0, int(request.query_params.get("window", "60")))
        except ValueError:
            window = 60
        qs = callbacks_due_soon_for_operator(op, window_seconds=window)
        return Response(
            {
                "count": qs.count(),
                "results": CallbackReminderSerializer(qs, many=True).data,
            }
        )


class CallbackDoneApi(APIView):
    permission_classes = [IsAuthenticatedAnyRole]

    def post(self, request, pk: int):
        cb = callback_get(pk)
        if not cb:
            return Response({"detail": "Не найден"}, status=404)
        callback_reminder_complete(reminder=cb, user=request.user)
        return Response(CallbackReminderSerializer(cb).data)


class CallbackSnoozeApi(APIView):
    permission_classes = [IsAuthenticatedAnyRole]

    def post(self, request, pk: int):
        cb = callback_get(pk)
        if not cb:
            return Response({"detail": "Не найден"}, status=404)
        ser = SnoozeInputSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        try:
            callback_reminder_snooze(
                reminder=cb, minutes=ser.validated_data["minutes"], user=request.user
            )
        except ApplicationError as exc:
            return Response({"detail": exc.message, **exc.extra}, status=400)
        return Response(CallbackReminderSerializer(cb).data)

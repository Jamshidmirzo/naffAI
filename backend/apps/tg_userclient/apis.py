"""
Thin API views for TG userclient (HackSoft pattern).

Auth flow:  POST start/ → verify-code/ → verify-password/ (if 2FA) → revoke/
Read-only:  GET status/, chats/, messages/, insights/
"""

from __future__ import annotations

from rest_framework import serializers, status
from rest_framework.exceptions import NotFound, PermissionDenied
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.users.models import Role

from .models import TgAiInsight, TgBackfillJob, TgChat, TgMessage, TgSession, TgSessionStatus
from .permissions import IsManagerOrTeamLead, IsSessionOwnerOrManager
from .selectors import (
    tg_backfill_jobs_for_operator,
    tg_chats_for_operator,
    tg_insights_for_chat,
    tg_insights_for_operator,
    tg_messages_for_chat,
    tg_session_by_id,
    tg_session_for_operator,
    tg_session_status_dict,
)
from .services import (
    _ensure_backfill_job,
    session_revoke,
    session_start,
    session_verify_code,
    session_verify_password,
)


def _operator_id_for_request(request) -> int:
    """Resolve the operator_id the request is acting on behalf of."""
    profile = getattr(request.user, "profile", None)
    if not profile:
        raise PermissionDenied("No profile")
    if not profile.operator_id:
        raise PermissionDenied("Not an operator")
    return profile.operator_id


# ---------------------------------------------------------------------------
# Auth flow endpoints
# ---------------------------------------------------------------------------


class TgSessionStartApi(APIView):
    permission_classes = [IsSessionOwnerOrManager]

    class InputSerializer(serializers.Serializer):
        phone = serializers.CharField()
        consent = serializers.BooleanField()

    def post(self, request):
        ser = self.InputSerializer(data=request.data)
        ser.is_valid(raise_exception=True)

        operator_id = _operator_id_for_request(request)

        try:
            session = session_start(
                operator_id=operator_id,
                phone=ser.validated_data["phone"],
                consent=ser.validated_data["consent"],
                user=request.user,
            )
        except ValueError as exc:
            msg = str(exc)
            if msg == "consent_required":
                return Response(
                    {"detail": "consent_required"},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            return Response({"detail": msg}, status=status.HTTP_400_BAD_REQUEST)
        except Exception as exc:
            # Telethon errors: PhoneNumberInvalidError etc.
            err_name = type(exc).__name__
            if "PhoneNumberInvalid" in err_name:
                return Response(
                    {"phone": "Неверный формат номера"},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            raise

        return Response(
            {"session_id": session.id, "status": session.status},
            status=status.HTTP_200_OK,
        )


class TgVerifyCodeApi(APIView):
    permission_classes = [IsSessionOwnerOrManager]

    class InputSerializer(serializers.Serializer):
        session_id = serializers.IntegerField()
        code = serializers.CharField()

    def post(self, request):
        ser = self.InputSerializer(data=request.data)
        ser.is_valid(raise_exception=True)

        operator_id = _operator_id_for_request(request)
        session = tg_session_by_id(ser.validated_data["session_id"])
        if not session or session.operator_id != operator_id:
            raise NotFound("Session not found")

        try:
            session = session_verify_code(
                session=session,
                code=ser.validated_data["code"],
                user=request.user,
            )
        except ValueError as exc:
            msg = str(exc)
            if msg == "code_invalid":
                return Response(
                    {"code": "Неверный код"},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            if msg == "code_expired":
                return Response(
                    {"code": "Код истёк, начни заново"},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            return Response({"detail": msg}, status=status.HTTP_400_BAD_REQUEST)

        return Response({"status": session.status})


class TgVerifyPasswordApi(APIView):
    permission_classes = [IsSessionOwnerOrManager]

    class InputSerializer(serializers.Serializer):
        session_id = serializers.IntegerField()
        password = serializers.CharField()

    def post(self, request):
        ser = self.InputSerializer(data=request.data)
        ser.is_valid(raise_exception=True)

        operator_id = _operator_id_for_request(request)
        session = tg_session_by_id(ser.validated_data["session_id"])
        if not session or session.operator_id != operator_id:
            raise NotFound("Session not found")

        try:
            session = session_verify_password(
                session=session,
                password=ser.validated_data["password"],
                user=request.user,
            )
        except ValueError as exc:
            msg = str(exc)
            if msg == "password_invalid":
                return Response(
                    {"password": "Неверный облачный пароль"},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            return Response({"detail": msg}, status=status.HTTP_400_BAD_REQUEST)

        return Response({"status": session.status})


class TgRevokeApi(APIView):
    permission_classes = [IsSessionOwnerOrManager]

    class InputSerializer(serializers.Serializer):
        session_id = serializers.IntegerField()

    def post(self, request):
        ser = self.InputSerializer(data=request.data)
        ser.is_valid(raise_exception=True)

        operator_id = _operator_id_for_request(request)
        session = tg_session_by_id(ser.validated_data["session_id"])
        if not session or session.operator_id != operator_id:
            raise NotFound("Session not found")

        session = session_revoke(session=session, user=request.user)
        return Response({"status": session.status})


class TgStatusApi(APIView):
    permission_classes = [IsSessionOwnerOrManager]

    def get(self, request):
        # For operators: their own session. For managers: query param.
        profile = getattr(request.user, "profile", None)
        role = profile.role if profile else None

        operator_id = request.query_params.get("operator")
        if operator_id:
            operator_id = int(operator_id)
            # Only managers can query other operators
            if role == Role.OPERATOR and profile.operator_id != operator_id:
                raise PermissionDenied()
        else:
            if not profile or not profile.operator_id:
                return Response({"status": None})
            operator_id = profile.operator_id

        return Response(tg_session_status_dict(operator_id))


# ---------------------------------------------------------------------------
# Manager read-only endpoints
# ---------------------------------------------------------------------------


class TgChatSerializer(serializers.ModelSerializer):
    lead_name = serializers.SerializerMethodField()

    class Meta:
        model = TgChat
        fields = [
            "id", "tg_chat_id", "kind", "title", "partner_name",
            "partner_phone", "lead_id", "lead_name", "last_message_at",
        ]

    def get_lead_name(self, obj: TgChat) -> str:
        if obj.lead_id and hasattr(obj, "lead") and obj.lead:
            return obj.lead.full_name or obj.lead.phone
        return ""


class TgChatsApi(APIView):
    permission_classes = [IsManagerOrTeamLead]

    def get(self, request):
        operator_id = request.query_params.get("operator")
        if not operator_id:
            return Response(
                {"detail": "operator query param required"},
                status=status.HTTP_400_BAD_REQUEST,
            )
        qs = tg_chats_for_operator(int(operator_id))
        data = TgChatSerializer(qs, many=True).data
        return Response(data)


class TgMessageSerializer(serializers.ModelSerializer):
    class Meta:
        model = TgMessage
        fields = [
            "id", "tg_message_id", "direction", "kind", "text",
            "transcript_status", "voice_duration_sec", "sent_at",
        ]


class TgMessagesApi(APIView):
    permission_classes = [IsManagerOrTeamLead]

    def get(self, request):
        chat_id = request.query_params.get("chat")
        if not chat_id:
            return Response(
                {"detail": "chat query param required"},
                status=status.HTTP_400_BAD_REQUEST,
            )
        limit = int(request.query_params.get("limit", 50))
        limit = min(limit, 200)
        qs = tg_messages_for_chat(int(chat_id), limit=limit)
        data = TgMessageSerializer(qs, many=True).data
        return Response(data)


class TgInsightSerializer(serializers.ModelSerializer):
    class Meta:
        model = TgAiInsight
        fields = [
            "id", "session_id", "chat_id", "since", "until",
            "model_version", "prompt_version", "summary",
            "quality_score", "red_flags", "highlights", "created_at",
        ]


class TgInsightsApi(APIView):
    permission_classes = [IsManagerOrTeamLead]

    def get(self, request):
        operator_id = request.query_params.get("operator")
        chat_id = request.query_params.get("chat")
        if chat_id:
            qs = tg_insights_for_chat(int(chat_id))
        elif operator_id:
            qs = tg_insights_for_operator(int(operator_id))
        else:
            return Response(
                {"detail": "operator or chat query param required"},
                status=status.HTTP_400_BAD_REQUEST,
            )
        data = TgInsightSerializer(qs[:20], many=True).data
        return Response(data)


class TgBackfillJobSerializer(serializers.ModelSerializer):
    class Meta:
        model = TgBackfillJob
        fields = [
            "id", "session_id", "status", "since", "chats_scanned",
            "messages_saved", "started_at", "finished_at", "last_error",
        ]


class TgBackfillJobsApi(APIView):
    permission_classes = [IsManagerOrTeamLead]

    def get(self, request):
        operator_id = request.query_params.get("operator")
        if not operator_id:
            return Response(
                {"detail": "operator query param required"},
                status=status.HTTP_400_BAD_REQUEST,
            )
        qs = tg_backfill_jobs_for_operator(int(operator_id))
        data = TgBackfillJobSerializer(qs, many=True).data
        return Response(data)


class TgRetryBackfillApi(APIView):
    permission_classes = [IsManagerOrTeamLead]

    class InputSerializer(serializers.Serializer):
        operator_id = serializers.IntegerField(required=False)
        session_id = serializers.IntegerField(required=False)

    def post(self, request):
        ser = self.InputSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        op_id = ser.validated_data.get("operator_id")
        sess_id = ser.validated_data.get("session_id")

        if sess_id:
            session = tg_session_by_id(sess_id)
        elif op_id:
            session = tg_session_for_operator(op_id)
        else:
            return Response(
                {"detail": "operator_id or session_id required"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        if not session or session.status != TgSessionStatus.ACTIVE:
            return Response(
                {"detail": "No active session found"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        job = _ensure_backfill_job(session)
        if not job:
            return Response(
                {"detail": "Backfill disabled or could not create job"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        return Response(
            {"job_id": job.id, "status": job.status},
            status=status.HTTP_200_OK,
        )


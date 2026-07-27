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



class TgQueueApi(APIView):
    """
    Manager-facing dashboard: per-operator TG session + latest backfill
    status in a single roll-up so the UI can show a queue overview
    without N round-trips.
    """

    permission_classes = [IsManagerOrTeamLead]

    def get(self, request):
        from apps.operators.models import Operator, OperatorStatus
        from django.db.models import Count, Prefetch

        sessions = (
            TgSession.objects
            .select_related("operator")
            .prefetch_related(
                Prefetch(
                    "backfill_jobs",
                    queryset=TgBackfillJob.objects.order_by("-created_at"),
                    to_attr="_recent_jobs",
                ),
            )
        )
        chat_counts = dict(
            TgChat.objects.values_list("session_id")
            .annotate(c=Count("id"))
            .values_list("session_id", "c")
        )
        msg_counts = dict(
            TgMessage.objects.values("chat__session_id")
            .annotate(c=Count("id"))
            .values_list("chat__session_id", "c")
        )
        insight_counts = dict(
            TgAiInsight.objects.values_list("session_id")
            .annotate(c=Count("id"))
            .values_list("session_id", "c")
        )

        rows = []
        for s in sessions:
            latest = s._recent_jobs[0] if s._recent_jobs else None
            rows.append({
                "operator_id": s.operator_id,
                "operator_name": s.operator.full_name,
                "session_id": s.id,
                "session_status": s.status,
                "tg_username": s.tg_username,
                "last_connected_at": s.last_connected_at.isoformat() if s.last_connected_at else None,
                "last_error": s.last_error,
                "chats_count": chat_counts.get(s.id, 0),
                "messages_count": msg_counts.get(s.id, 0),
                "insights_count": insight_counts.get(s.id, 0),
                "latest_job": (
                    {
                        "id": latest.id,
                        "status": latest.status,
                        "since": latest.since.isoformat() if latest.since else None,
                        "started_at": latest.started_at.isoformat() if latest.started_at else None,
                        "finished_at": latest.finished_at.isoformat() if latest.finished_at else None,
                        "chats_scanned": latest.chats_scanned,
                        "messages_saved": latest.messages_saved,
                        "last_error": latest.last_error,
                    }
                    if latest
                    else None
                ),
            })

        # Also include active operators with NO session (so manager sees
        # who still needs onboarding).
        connected_op_ids = {r["operator_id"] for r in rows}
        for op in Operator.objects.filter(status=OperatorStatus.ACTIVE).exclude(id__in=connected_op_ids):
            rows.append({
                "operator_id": op.id,
                "operator_name": op.full_name,
                "session_id": None,
                "session_status": "none",
                "tg_username": "",
                "last_connected_at": None,
                "last_error": "",
                "chats_count": 0,
                "messages_count": 0,
                "insights_count": 0,
                "latest_job": None,
            })

        # Sort: active/running first, then errors, then none.
        def _sort_key(r):
            order = {"running": 0, "pending": 1, "active": 2, "error": 3, "pending_code": 4, "pending_2fa": 4, "none": 5}
            job_status = (r["latest_job"] or {}).get("status", "")
            return (order.get(job_status or r["session_status"], 9), r["operator_name"])

        rows.sort(key=_sort_key)
        return Response({"queue": rows, "total": len(rows)})


class TgCoachingApi(APIView):
    """
    POST /tg-userclient/coaching/  {chat_id, message_ids: [1,2,3]}

    Given a set of *outgoing* messages the operator sent in a chat,
    build a compact conversation window (selected + a few neighbours
    for context) and ask the configured LLM to:
      - flag rude / unprofessional / missed-opportunity phrases,
      - suggest a better phrasing per issue,
      - mark voice notes as "transcript unavailable" so managers
        know why we can't judge them.

    The response is meant to be a coaching card, not a mass mailer.
    """

    permission_classes = [IsManagerOrTeamLead]

    def post(self, request):
        import json
        from rest_framework.exceptions import ValidationError
        from django.utils.timezone import now
        from apps.tg_userclient.ai.provider import get_llm_provider

        chat_id = request.data.get("chat_id")
        raw_ids = request.data.get("message_ids") or []
        language = (request.data.get("language") or "ru").lower()
        if language not in {"ru", "uz"}:
            language = "ru"
        if not chat_id:
            raise ValidationError({"chat_id": "required"})
        try:
            message_ids = [int(x) for x in raw_ids]
        except (TypeError, ValueError):
            raise ValidationError({"message_ids": "must be integers"})
        if not message_ids or len(message_ids) > 30:
            raise ValidationError({"message_ids": "1..30 IDs required"})

        try:
            chat = TgChat.objects.select_related("session__operator").get(pk=chat_id)
        except TgChat.DoesNotExist:
            raise NotFound("Chat not found")

        selected = list(
            TgMessage.objects.filter(chat=chat, id__in=message_ids).order_by("sent_at")
        )
        if not selected:
            raise ValidationError({"message_ids": "no messages found in this chat"})

        # Build a context window: 4 messages before the earliest and
        # 4 after the latest selected — enough to see what the operator
        # was responding to.
        first_at = selected[0].sent_at
        last_at = selected[-1].sent_at
        before = list(
            TgMessage.objects.filter(chat=chat, sent_at__lt=first_at)
            .order_by("-sent_at")[:4]
        )
        after = list(
            TgMessage.objects.filter(chat=chat, sent_at__gt=last_at)
            .order_by("sent_at")[:4]
        )
        window = sorted(
            {m.id: m for m in [*before, *selected, *after]}.values(),
            key=lambda m: m.sent_at,
        )
        selected_ids_set = {m.id for m in selected}

        # Build a compact LLM-friendly transcript.
        def _fmt(m: TgMessage) -> str:
            who = "OPERATOR" if m.direction == "out" else "CLIENT"
            marker = " ►" if m.id in selected_ids_set else ""
            when = m.sent_at.strftime("%d.%m %H:%M")
            if m.kind == "voice":
                body = f"[voice {m.voice_duration_sec or 0}s — TRANSCRIPT UNAVAILABLE]"
            elif not m.text:
                body = f"[{m.kind}]"
            else:
                body = m.text.strip().replace("\n", " ")[:400]
            return f"[{when}] {who}{marker}: {body} (id={m.id})"

        transcript = "\n".join(_fmt(m) for m in window)
        has_voice_selected = any(m.kind == "voice" for m in selected)

        lang_rules_map = {
            "ru": (
                "- Отвечай на русском, коротко и по делу.\n"
                "- Если сообщение отмечено [voice ... TRANSCRIPT UNAVAILABLE] — "
                "укажи в problem: 'нужен транскрипт голосового' и severity: 'low'.\n"
                "- Если ошибок нет — верни пустой issues и напиши positive summary."
            ),
            "uz": (
                "- Javob faqat o'zbek tilida (lotin yozuvida), qisqa va aniq.\n"
                "- Agar xabar [voice ... TRANSCRIPT UNAVAILABLE] deb belgilangan bo'lsa — "
                "problem: 'ovozli xabar transkripsiyasi kerak' va severity: 'low'.\n"
                "- Xatolik topilmasa — bo'sh issues qaytar va ijobiy summary yoz.\n"
                "- Suggestion — operator nomidan tayyor javob, o'zbekcha."
            ),
        }
        prompt = (
            "Ты — коуч операторов колл-центра в Ташкенте. Твоя задача — "
            "проанализировать конкретные сообщения оператора (помечены ►) "
            "в переписке с клиентом и указать грубые ошибки, упущенные "
            "возможности продажи или проблемы с тоном.\n\n"
            "Правила:\n"
            f"{lang_rules_map[language]}\n"
            "- Для каждого проблемного сообщения дай: severity (high/mid/low), "
            "problem (что не так, 1 фраза), suggestion (как лучше сказать, "
            "готовая реплика от лица оператора).\n"
            "- Возвращай ТОЛЬКО JSON, без markdown-обёртки:\n"
            "{\n"
            '  "summary": "1-2 фразы о качестве переписки в этом фрагменте",\n'
            '  "issues": [\n'
            '    {"message_id": 42, "severity": "high", "problem": "...", "suggestion": "..."}\n'
            "  ]\n"
            "}\n\n"
            f"Переписка (► = проанализировать):\n{transcript}"
        )

        provider = get_llm_provider()
        try:
            response = provider.chat_with_tools(
                history=[{"role": "user", "content": prompt, "tool_name": ""}],
                tool_specs={},
                system_prompt=(
                    "Ты — коуч операторов продаж. Отвечай ТОЛЬКО валидным "
                    "JSON, никакого markdown-обёртывания."
                ),
            )
            text = (response.text or "").strip()
            # Some providers wrap JSON in ```json ... ``` — strip it.
            if text.startswith("```"):
                text = text.strip("`")
                if text.startswith("json"):
                    text = text[4:]
                text = text.strip()
            parsed = json.loads(text)
        except Exception as exc:  # noqa: BLE001
            return Response(
                {
                    "summary": (
                        "AI-анализ временно недоступен — сохраните выбранные "
                        "сообщения и попробуйте позже."
                    ),
                    "issues": [],
                    "has_voice_selected": has_voice_selected,
                    "provider": "none",
                    "error": str(exc)[:200],
                },
                status=200,
            )

        return Response({
            "summary": parsed.get("summary", ""),
            "issues": parsed.get("issues", []),
            "has_voice_selected": has_voice_selected,
            "provider": getattr(response, "provider_used", "") or "",
            "model": getattr(response, "model_version", "") or "",
            "created_at": now().isoformat(),
        })

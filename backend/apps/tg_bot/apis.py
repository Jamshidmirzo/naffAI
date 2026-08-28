"""
DRF APIs for the v2 bot configuration UI (`/api/bot/*`).

Manager-only. Serializes BotChat / BotReport / BotAuditLog + block
metadata, exposes CRUD for reports and read-only for templates, plus
preview + send-now + test-send + preview-as (RBAC-simulated) for the
"try before you save" workflow in the web editor.
"""

from __future__ import annotations

import datetime as dt

from rest_framework import serializers, status, viewsets
from rest_framework.decorators import action
from rest_framework.pagination import PageNumberPagination
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.users.permissions import IsTeamLead

from .models import (
    BotAuditLog,
    BotChat,
    BotReport,
    BotReportPeriod,
    BotReportTemplate,
    BotSubscription,
)
from .renderer import render_report_full
from .report_blocks import BLOCKS, CATEGORIES
from .scheduler import send_report_now_sync, send_report_to_chat_sync
from .selectors import bot_subscribers_all
from .services import subscription_update


class BotChatSerializer(serializers.ModelSerializer):
    linked_profile_name = serializers.SerializerMethodField()

    class Meta:
        model = BotChat
        fields = [
            "id",
            "chat_id",
            "kind",
            "title",
            "language",
            "is_active",
            "linked_profile",
            "linked_profile_name",
            "last_seen_at",
            "created_at",
        ]

    def get_linked_profile_name(self, obj: BotChat) -> str:
        p = obj.linked_profile
        if not p:
            return ""
        u = getattr(p, "user", None)
        if u:
            return u.get_full_name() or u.username
        return ""


class BotReportSerializer(serializers.ModelSerializer):
    recipient_ids = serializers.PrimaryKeyRelatedField(
        source="recipients",
        many=True,
        queryset=BotChat.objects.all(),
        write_only=True,
        required=False,
    )
    recipients = BotChatSerializer(many=True, read_only=True)

    class Meta:
        model = BotReport
        fields = [
            "id",
            "name",
            "enabled",
            "schedule_time",
            "schedule_days",
            "recipients",
            "recipient_ids",
            "blocks",
            "language",
            "period",
            "include_header",
            "last_sent_at",
            "last_send_error",
            "created_at",
            "updated_at",
        ]
        read_only_fields = ["last_sent_at", "last_send_error", "created_at", "updated_at"]


class BotReportTemplateSerializer(serializers.ModelSerializer):
    class Meta:
        model = BotReportTemplate
        fields = [
            "id",
            "slug",
            "name",
            "description",
            "category",
            "blocks",
            "schedule_defaults",
            "sort_order",
            "is_active",
        ]


class BotAuditPagination(PageNumberPagination):
    page_size = 50
    page_size_query_param = "page_size"
    max_page_size = 200


class BotAuditLogSerializer(serializers.ModelSerializer):
    class Meta:
        model = BotAuditLog
        fields = [
            "id",
            "at",
            "chat_id",
            "chat_kind",
            "tg_user_id",
            "username",
            "linked_operator_id",
            "command",
            "args",
            "outcome",
            "error_detail",
        ]


class BotChatListApi(APIView):
    permission_classes = [IsTeamLead]

    def get(self, request):
        qs = BotChat.objects.all().order_by("-last_seen_at")
        kind = request.query_params.get("kind")
        if kind:
            qs = qs.filter(kind=kind)
        return Response({"results": BotChatSerializer(qs, many=True).data, "count": qs.count()})


class BotChatDetailApi(APIView):
    permission_classes = [IsTeamLead]

    def patch(self, request, pk: int):
        chat = BotChat.objects.filter(pk=pk).first()
        if not chat:
            return Response({"detail": "Not found"}, status=404)
        # Allow updating language + is_active + linked_profile (edit only).
        for field in ("language", "is_active"):
            if field in request.data:
                setattr(chat, field, request.data[field])
        if "linked_profile" in request.data:
            chat.linked_profile_id = request.data["linked_profile"]
        chat.save()
        return Response(BotChatSerializer(chat).data)


def _build_report_from_draft(data: dict) -> BotReport:
    """
    Build an unsaved BotReport instance from a POST body — used by
    /preview_as/ so the caller can preview a draft that hasn't been
    saved yet (or edits that are staged in the editor but not persisted).
    """
    report = BotReport(
        name=data.get("name") or "preview",
        enabled=data.get("enabled", True),
        schedule_time=data.get("schedule_time") or "09:00:00",
        schedule_days=data.get("schedule_days") or [],
        blocks=data.get("blocks") or [],
        language=data.get("language") or "uz",
        period=data.get("period") or "today",
        include_header=data.get("include_header", True),
    )
    return report


class BotReportViewSet(viewsets.ModelViewSet):
    permission_classes = [IsTeamLead]
    serializer_class = BotReportSerializer
    queryset = BotReport.objects.all().prefetch_related("recipients")

    def perform_create(self, serializer):
        serializer.save(created_by=self.request.user)

    @action(detail=True, methods=["post"])
    def send_now(self, request, pk=None):
        """Manual dispatch. Uses the same scheduler code as the cron."""
        report = self.get_object()
        try:
            result = send_report_now_sync(report)
        except Exception as exc:
            return Response(
                {"detail": f"Send failed: {exc}"},
                status=status.HTTP_500_INTERNAL_SERVER_ERROR,
            )
        return Response(result)

    @action(detail=True, methods=["post"], url_path="test_send")
    def test_send(self, request, pk=None):
        """
        Send THIS saved report to ONE arbitrary chat right now (bypass
        schedule + last_sent_at). Body: `{"chat_id": <BotChat.id>}`.
        """
        report = self.get_object()
        chat_id = request.data.get("chat_id")
        if not chat_id:
            return Response({"detail": "chat_id (BotChat.id) is required"}, status=400)
        chat = BotChat.objects.filter(pk=chat_id).first()
        if not chat:
            return Response({"detail": "Chat not found"}, status=404)
        try:
            result = send_report_to_chat_sync(report, chat)
        except Exception as exc:
            return Response(
                {"detail": f"Send failed: {exc}"},
                status=status.HTTP_500_INTERNAL_SERVER_ERROR,
            )
        return Response(result)

    @action(detail=True, methods=["post"])
    def preview(self, request, pk=None):
        """
        Render the SAVED report against each active recipient and return
        the HTML (without actually sending). Kept for legacy editor use;
        new UI uses `preview_as/`.
        """
        report = self.get_object()
        recipients = list(report.recipients.filter(is_active=True))
        if not recipients:
            fake = BotChat(chat_id=0, kind="private", language=report.language, title="preview")
            rendered = render_report_full(report, fake)
            return Response(
                {"previews": [{"chat_id": 0, "kind": "private", "html": rendered.html}]}
            )
        previews = []
        for chat in recipients:
            rendered = render_report_full(report, chat)
            previews.append(
                {
                    "chat_id": chat.chat_id,
                    "kind": chat.kind,
                    "title": chat.title,
                    "html": rendered.html,
                    "buttons": [{"text": b.text, "url": b.url} for b in rendered.buttons],
                }
            )
        return Response({"previews": previews})


class BotReportPreviewAsApi(APIView):
    """
    POST /api/bot/reports/preview_as/

    Body:
        {
            "draft": { ...BotReport payload without id... },
            "chat_id": <BotChat.id | null>
        }

    Renders `draft` as it would be seen by that specific BotChat (RBAC
    + sensitivity filtering applied for the chat's kind + language).
    If `chat_id` is null / missing, uses a phantom private chat so
    every block is shown (best for editor default preview).

    Kept as a plain APIView instead of a ViewSet @action so the editor
    can call it without knowing an existing report id (draft mode).
    """

    permission_classes = [IsTeamLead]

    def post(self, request):
        draft = request.data.get("draft") or {}
        chat_id = request.data.get("chat_id")
        report = _build_report_from_draft(draft)
        chat: BotChat | None = None
        if chat_id:
            chat = BotChat.objects.filter(pk=chat_id).first()
        if not chat:
            chat = BotChat(
                chat_id=0,
                kind="private",
                language=report.language,
                title="preview",
            )
        rendered = render_report_full(report, chat)
        return Response(
            {
                "html": rendered.html,
                "buttons": [{"text": b.text, "url": b.url} for b in rendered.buttons],
                "chat_kind": chat.kind,
                "chat_title": chat.title,
                "chat_language": chat.language,
            }
        )


class BotBlocksApi(APIView):
    """Static metadata about available report blocks — for the editor."""

    permission_classes = [IsTeamLead]

    def get(self, request):
        data = []
        for slug, spec in BLOCKS.items():
            data.append(
                {
                    "slug": slug,
                    "label_ru": spec.label_ru,
                    "label_uz": spec.label_uz,
                    "category": spec.category,
                    "sensitive": spec.sensitive,
                }
            )
        periods = [{"slug": p.value, "label": p.label} for p in BotReportPeriod]
        return Response({"blocks": data, "periods": periods, "categories": list(CATEGORIES)})


class BotTemplateListApi(APIView):
    """GET /api/bot/templates/ — read-only list for the gallery modal."""

    permission_classes = [IsTeamLead]

    def get(self, request):
        qs = BotReportTemplate.objects.filter(is_active=True).order_by("sort_order", "id")
        return Response({"results": BotReportTemplateSerializer(qs, many=True).data})


class BotSubscriberSerializer(serializers.ModelSerializer):
    """
    Row shape for `/bot/subscribers/` — enriched with resolved
    Operator/Profile summaries so the UI doesn't need a second lookup.
    """

    linked_operator = serializers.SerializerMethodField()
    linked_profile = serializers.SerializerMethodField()

    class Meta:
        model = BotSubscription
        fields = [
            "id",
            "chat_id",
            "chat_title",
            "phone",
            "language",
            "is_active",
            "receives_broadcasts",
            "blocked_at",
            "linked_operator",
            "linked_profile",
            "last_seen_at",
            "created_at",
            "updated_at",
        ]

    def get_linked_operator(self, obj: BotSubscription) -> dict | None:
        op = obj.linked_operator
        if not op:
            return None
        return {
            "id": op.id,
            "full_name": op.full_name,
            "status": op.status,
            "phone": op.phone,
        }

    def get_linked_profile(self, obj: BotSubscription) -> dict | None:
        prof = obj.linked_profile
        if not prof:
            return None
        u = prof.user
        return {
            "id": prof.id,
            "username": getattr(u, "username", ""),
            "full_name": (u.get_full_name() if u else "") or "",
            "role": prof.role,
        }


class BotSubscriberListApi(APIView):
    """
    GET /api/bot/subscribers/ — full list of `BotSubscription` rows
    (active + inactive + blocked), sorted for the UI:
      receives_broadcasts DESC (subscribers first), then
      last_seen_at DESC (newest activity first).

    Manager-only. The FE uses this list to toggle broadcast opt-in and
    to verify who exactly is receiving the 3-hour leaderboard.
    """

    permission_classes = [IsTeamLead]

    def get(self, request):
        qs = bot_subscribers_all().order_by(
            "-receives_broadcasts", "-last_seen_at", "-id"
        )
        data = BotSubscriberSerializer(qs, many=True).data
        return Response({"results": data, "count": len(data)})


class BotSubscriberDetailApi(APIView):
    """
    PATCH /api/bot/subscribers/{id}/ — surgical update of one row.

    Body accepts any subset of `{receives_broadcasts, phone}`. Phone
    changes trigger operator/profile re-linking inside the service.
    Response is the refreshed row so the FE can drop the local optimistic
    state without an extra GET.
    """

    permission_classes = [IsTeamLead]

    def patch(self, request, pk: int):
        sub = BotSubscription.objects.filter(pk=pk).first()
        if not sub:
            return Response({"detail": "Not found"}, status=404)
        payload = request.data or {}
        subscription_update(
            subscription=sub,
            actor=request.user,
            receives_broadcasts=payload.get("receives_broadcasts"),
            phone=payload.get("phone"),
        )
        sub.refresh_from_db()
        return Response(BotSubscriberSerializer(sub).data)


class BotAuditListApi(APIView):
    permission_classes = [IsTeamLead]
    pagination_class = BotAuditPagination

    def get(self, request):
        qs = BotAuditLog.objects.all()
        if request.query_params.get("chat_id"):
            qs = qs.filter(chat_id=int(request.query_params["chat_id"]))
        if request.query_params.get("command"):
            qs = qs.filter(command__icontains=request.query_params["command"])
        if request.query_params.get("outcome"):
            qs = qs.filter(outcome=request.query_params["outcome"])
        days = int(request.query_params.get("days", 7))
        if days > 0:
            since = dt.datetime.now() - dt.timedelta(days=days)
            qs = qs.filter(at__gte=since)
        paginator = BotAuditPagination()
        page = paginator.paginate_queryset(qs.order_by("-at"), request)
        return paginator.get_paginated_response(BotAuditLogSerializer(page or [], many=True).data)

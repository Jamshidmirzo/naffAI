"""
DRF APIs for the v2 bot configuration UI (`/api/bot/*`).

Manager-only. Serializes BotChat / BotReport / BotAuditLog + block
metadata, exposes CRUD for reports, plus preview + send-now for the
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

from .models import BotAuditLog, BotChat, BotReport, BotReportPeriod
from .renderer import render_report
from .report_blocks import BLOCKS
from .scheduler import send_report_now_sync


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
        return Response(
            {"results": BotChatSerializer(qs, many=True).data, "count": qs.count()}
        )


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

    @action(detail=True, methods=["post"])
    def preview(self, request, pk=None):
        """
        Render the report against each recipient and return the HTML
        (without actually sending). Useful for the editor's "preview" panel.
        """
        report = self.get_object()
        recipients = list(report.recipients.filter(is_active=True))
        if not recipients:
            # Preview against a phantom "private" chat so the block-set is unfiltered.
            fake = BotChat(chat_id=0, kind="private", language=report.language, title="preview")
            html = render_report(report, fake)
            return Response({"previews": [{"chat_id": 0, "kind": "private", "html": html}]})
        previews = []
        for chat in recipients:
            previews.append(
                {
                    "chat_id": chat.chat_id,
                    "kind": chat.kind,
                    "title": chat.title,
                    "html": render_report(report, chat),
                }
            )
        return Response({"previews": previews})


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
                    "sensitive": spec.sensitive,
                }
            )
        periods = [
            {"slug": p.value, "label": p.label} for p in BotReportPeriod
        ]
        return Response({"blocks": data, "periods": periods})


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
        return paginator.get_paginated_response(
            BotAuditLogSerializer(page or [], many=True).data
        )

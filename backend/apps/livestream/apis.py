"""
Thin DRF views for the livestream app. All business logic lives in
`services.py` and `selectors.py` — these only parse / permission / shape.
"""

from __future__ import annotations

import logging

from rest_framework import serializers, status
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.users.models import Role
from apps.users.permissions import (
    IsAuthenticatedAnyRole,
    IsSuperadminOrManager,
    _role,
)

from .selectors import (
    live_now_as_dicts,
    livestream_enabled_operators,
    recording_detail,
    recordings_queryset,
)
from .services import (
    LivestreamConfigError,
    LivestreamDisabledError,
    LivestreamWebhookError,
    recording_presigned_url,
    room_token_issue,
    verify_webhook_signature,
    webhook_ingest,
)

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# POST /live/room-token/
# ---------------------------------------------------------------------------


class RoomTokenApi(APIView):
    """
    Issue a LiveKit AccessToken for the caller.

    - operator → publish-only (needs Operator.livestream_enabled=True).
    - manager / super_manager / superadmin → subscribe + room admin.
    """

    permission_classes = [IsAuthenticated, IsAuthenticatedAnyRole]

    def post(self, request):
        user = request.user
        role = _role(user)
        if role == Role.OPERATOR:
            profile = getattr(user, "profile", None)
            operator = getattr(profile, "operator", None) if profile else None
            try:
                result = room_token_issue(
                    user=user, operator=operator, role="operator"
                )
            except LivestreamDisabledError as exc:
                return Response(
                    {"detail": str(exc), "code": "livestream_disabled"},
                    status=status.HTTP_403_FORBIDDEN,
                )
            except LivestreamConfigError as exc:
                return Response(
                    {"detail": str(exc), "code": "livestream_misconfigured"},
                    status=status.HTTP_503_SERVICE_UNAVAILABLE,
                )
        else:
            try:
                result = room_token_issue(user=user, operator=None, role="manager")
            except LivestreamConfigError as exc:
                return Response(
                    {"detail": str(exc), "code": "livestream_misconfigured"},
                    status=status.HTTP_503_SERVICE_UNAVAILABLE,
                )
        return Response(
            {
                "ws_url": result.ws_url,
                "room_name": result.room_name,
                "participant_identity": result.participant_identity,
                "participant_name": result.participant_name,
                "token": result.token,
                "can_publish": result.can_publish,
                "can_subscribe": result.can_subscribe,
                "expires_at": result.expires_at.isoformat(),
            }
        )


# ---------------------------------------------------------------------------
# GET /live/live-now/
# ---------------------------------------------------------------------------


class LiveNowApi(APIView):
    """
    Manager-facing poll endpoint — who is currently publishing. Lightweight
    so it can be polled every ~5 seconds from the LiveWall UI.
    """

    permission_classes = [IsAuthenticated, IsSuperadminOrManager]

    def get(self, request):
        enabled = [
            {
                "id": op.id,
                "full_name": op.full_name,
                "status": op.status,
            }
            for op in livestream_enabled_operators()
        ]
        return Response(
            {
                "live_now": live_now_as_dicts(),
                "enabled_operators": enabled,
            }
        )


# ---------------------------------------------------------------------------
# GET /live/recordings/
# ---------------------------------------------------------------------------


class RecordingListSerializer(serializers.Serializer):
    id = serializers.IntegerField()
    operator_id = serializers.IntegerField(allow_null=True)
    operator_name = serializers.CharField(allow_null=True, allow_blank=True)
    participant_identity = serializers.CharField(allow_blank=True)
    room_name = serializers.CharField(allow_blank=True)
    status = serializers.CharField()
    started_at = serializers.DateTimeField(allow_null=True)
    ended_at = serializers.DateTimeField(allow_null=True)
    duration_s = serializers.IntegerField(allow_null=True)
    size_bytes = serializers.IntegerField(allow_null=True)


class RecordingListApi(APIView):
    """
    Manager-facing list of finished recordings. Supports:
        ?operator_id=
        ?date_from=YYYY-MM-DD
        ?date_to=YYYY-MM-DD
        ?page_size=25 (default 25, max 200)
    """

    permission_classes = [IsAuthenticated, IsSuperadminOrManager]

    def get(self, request):
        import datetime as _dt

        operator_id = request.query_params.get("operator_id")
        date_from = request.query_params.get("date_from")
        date_to = request.query_params.get("date_to")
        page_size = request.query_params.get("page_size", "25")

        try:
            op_id = int(operator_id) if operator_id else None
        except (TypeError, ValueError):
            op_id = None

        def _parse(d: str | None) -> _dt.date | None:
            if not d:
                return None
            try:
                return _dt.date.fromisoformat(d)
            except ValueError:
                return None

        try:
            page = min(max(int(page_size), 1), 200)
        except (TypeError, ValueError):
            page = 25

        qs = recordings_queryset(
            operator_id=op_id,
            date_from=_parse(date_from),
            date_to=_parse(date_to),
            only_finished=True,
        )

        rows = []
        for r in qs[:page]:
            rows.append(
                {
                    "id": r.id,
                    "operator_id": r.operator_id,
                    "operator_name": r.operator.full_name if r.operator_id else None,
                    "participant_identity": r.participant_identity,
                    "room_name": r.room_name,
                    "status": r.status,
                    "started_at": r.started_at,
                    "ended_at": r.ended_at,
                    "duration_s": r.duration_s,
                    "size_bytes": r.size_bytes,
                }
            )
        return Response({"results": RecordingListSerializer(rows, many=True).data})


# ---------------------------------------------------------------------------
# GET /live/recordings/<id>/url/
# ---------------------------------------------------------------------------


class RecordingUrlApi(APIView):
    permission_classes = [IsAuthenticated, IsSuperadminOrManager]

    def get(self, request, pk: int):
        rec = recording_detail(pk)
        if rec is None:
            return Response(
                {"detail": "Запись не найдена."}, status=status.HTTP_404_NOT_FOUND
            )
        try:
            url = recording_presigned_url(recording=rec, expires_in=600)
        except (ValueError, LivestreamConfigError) as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        return Response({"url": url, "expires_in": 600})


# ---------------------------------------------------------------------------
# POST /live/webhooks/livekit/
# ---------------------------------------------------------------------------


class LiveKitWebhookApi(APIView):
    """
    LiveKit server webhook ingress. Verified by a signed JWT in the
    `Authorization` header using our LIVEKIT_API_SECRET. The POST body is
    JSON (the webhook event).

    We swallow handler errors on purpose — LiveKit retries webhooks on
    5xx responses and we already dedupe via LiveKitWebhookEvent.event_id,
    so a persistent handler bug would turn into infinite retry loops.
    """

    permission_classes = [AllowAny]
    authentication_classes: list = []

    def post(self, request):
        auth = request.headers.get("Authorization", "")
        try:
            payload = verify_webhook_signature(raw_body=request.body, auth_header=auth)
        except LivestreamWebhookError as exc:
            logger.warning("livestream webhook rejected: %s", exc)
            return Response({"detail": str(exc)}, status=status.HTTP_401_UNAUTHORIZED)
        except LivestreamConfigError as exc:
            # If LiveKit isn't configured here, the webhook shouldn't be
            # routed at us — but respond 200 anyway so LiveKit doesn't
            # retry forever.
            logger.warning("livestream webhook received but config missing: %s", exc)
            return Response({"status": "no_config"})

        result = webhook_ingest(payload=payload)
        return Response(result)

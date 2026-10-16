"""
Thin DRF views for the livestream app. All business logic lives in
`services.py` and `selectors.py` — these only parse / permission / shape.
"""

from __future__ import annotations

import logging

from django.http import HttpResponse
from rest_framework import serializers, status
from rest_framework.parsers import FormParser, JSONParser, MultiPartParser
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.operators.models import Operator
from apps.system_settings.selectors import livestream_globally_enabled
from apps.users.models import Role
from apps.users.permissions import (
    IsAuthenticatedAnyRole,
    IsSuperadminOrManager,
    _role,
)
from apps.users.selectors import visible_operator_ids

from .models import LiveSnapshot, LiveSnapshotStatus
from .selectors import (
    live_now_payload,
    recording_detail,
    recordings_queryset,
    snapshot_detail,
)
from .services import (
    SNAPSHOT_MAX_BYTES,
    LivestreamConfigError,
    LivestreamDisabledError,
    LivestreamWebhookError,
    livestream_global_set,
    participants_fetch_cached,
    recording_enabled,
    recording_presigned_url,
    room_name,
    room_token_issue,
    SnapshotError,
    sessions_reconcile,
    snapshot_report_error,
    snapshot_request,
    snapshot_upload,
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
        # Global killswitch — SystemSetting.livestream_global_enabled.
        # Касается ТОЛЬКО операторов (publishers). Менеджер / super_manager /
        # superadmin всё равно получают subscribe-токен, чтобы могли открыть
        # /live/wall и нажать «включить обратно». Без этого исключения
        # сервер становится недоступен для управления kill-switch'ем.
        if role == Role.OPERATOR and not livestream_globally_enabled():
            return Response(
                {
                    "detail": "Live-эфир временно отключён менеджером",
                    "code": "livestream_global_disabled",
                },
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )
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
    Manager-facing poll endpoint — who is publishing, scoped to the
    caller's operators. When LiveKit's server API is reachable the rows
    are reconciled against its participant list first (cached ~10s), so
    the wall never shows a ghost or misses a publisher for long.
    """

    permission_classes = [IsAuthenticated, IsSuperadminOrManager]

    def get(self, request):
        participants = participants_fetch_cached()
        if participants is not None:
            sessions_reconcile(participants=participants)
        payload = live_now_payload(actor=request.user)
        return Response(
            {
                "source": "livekit" if participants is not None else "db",
                "room_name": room_name(),
                "recording_enabled": recording_enabled(),
                **payload,
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
    Manager-facing list of finished recordings (hourly chunks), scoped to
    the caller's operators. Supports:
        ?operator_id=
        ?date_from=YYYY-MM-DD
        ?date_to=YYYY-MM-DD
        ?limit=50 (max 200; legacy ?page_size=) &offset=
    """

    permission_classes = [IsAuthenticated, IsSuperadminOrManager]

    def get(self, request):
        import datetime as _dt

        params = request.query_params

        def _int(value, default: int | None) -> int | None:
            try:
                return int(value) if value not in (None, "") else default
            except (TypeError, ValueError):
                return default

        def _date(d: str | None) -> _dt.date | None:
            if not d:
                return None
            try:
                return _dt.date.fromisoformat(d)
            except ValueError:
                return None

        limit = min(max(_int(params.get("limit", params.get("page_size")), 50) or 50, 1), 200)
        offset = max(_int(params.get("offset"), 0) or 0, 0)
        qs = recordings_queryset(
            actor=request.user,
            operator_id=_int(params.get("operator_id"), None),
            date_from=_date(params.get("date_from")),
            date_to=_date(params.get("date_to")),
            only_finished=True,
        )
        rows = [
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
            for r in qs[offset : offset + limit]
        ]
        return Response(
            {"count": qs.count(), "results": RecordingListSerializer(rows, many=True).data}
        )


# ---------------------------------------------------------------------------
# GET /live/recordings/<id>/url/
# ---------------------------------------------------------------------------


class RecordingUrlApi(APIView):
    permission_classes = [IsAuthenticated, IsSuperadminOrManager]

    def get(self, request, pk: int):
        rec = recording_detail(actor=request.user, pk=pk)
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
    # LiveKit sends every room/track/participant event from one IP — the
    # anonymous rate limit would drop them. The body is signed instead.
    throttle_classes: list = []

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


# ---------------------------------------------------------------------------
# GET / PATCH /live/global-status/  — killswitch
# ---------------------------------------------------------------------------


class GlobalStatusApi(APIView):
    """
    GET  — любой залогиненный (operator читает чтобы знать публиковать ли).
    PATCH — только superadmin / super_manager / manager (toggle).

    Шлётся из:
    - LiveStreamPublisher.tsx — poll каждые 10с чтобы остановить публикацию.
    - LiveWall.tsx — большая кнопка toggle сверху у менеджера.
    """

    permission_classes = [IsAuthenticated, IsAuthenticatedAnyRole]

    def get(self, request):
        return Response({"enabled": livestream_globally_enabled()})

    def patch(self, request):
        role = _role(request.user)
        allowed = {Role.SUPERADMIN, Role.SUPER_MANAGER, Role.MANAGER, Role.TEAM_LEAD}
        if not request.user.is_superuser and role not in allowed:
            return Response(
                {"detail": "Только менеджер может переключать killswitch"},
                status=status.HTTP_403_FORBIDDEN,
            )
        ser = KillswitchSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        enabled = ser.validated_data["enabled"]
        livestream_global_set(enabled=enabled, user=request.user)
        logger.info(
            "live global killswitch set to %s by %s", enabled, request.user.username
        )
        return Response({"enabled": enabled})


class KillswitchSerializer(serializers.Serializer):
    enabled = serializers.BooleanField()


# ---------------------------------------------------------------------------
# GET /live/config/
# ---------------------------------------------------------------------------


class LiveConfigApi(APIView):
    """What the UI needs to know about this environment's live setup."""

    permission_classes = [IsAuthenticated, IsAuthenticatedAnyRole]

    def get(self, request):
        from django.conf import settings

        return Response(
            {
                "configured": bool(
                    settings.LIVEKIT_API_KEY and settings.LIVEKIT_API_SECRET and settings.LIVEKIT_WS_URL
                ),
                "recording_enabled": recording_enabled(),
                "room_name": room_name(),
                "retention_days": settings.LIVEKIT_RECORDING_RETENTION_DAYS,
            }
        )


# ---------------------------------------------------------------------------
# Snapshots: POST /live/snapshots/, GET /live/snapshots/<id>/[image/],
# POST /live/snapshots/<id>/upload/ (the operator's publisher)
# ---------------------------------------------------------------------------


class SnapshotRequestSerializer(serializers.Serializer):
    operator_id = serializers.IntegerField()


def _snapshot_payload(snap) -> dict:
    return {
        "id": str(snap.id),
        "status": snap.status,
        "operator_id": snap.operator_id,
        "operator_name": snap.operator.full_name,
        "error": snap.error_text,
        "width": snap.width,
        "height": snap.height,
        "created_at": snap.created_at.isoformat(),
        "taken_at": snap.taken_at.isoformat() if snap.taken_at else None,
    }


def _snapshot_error(exc: SnapshotError) -> Response:
    return Response({"detail": str(exc), "code": exc.code}, status=exc.status)


class SnapshotCreateApi(APIView):
    """Ask an operator's live camera for one frame. Poll the returned id."""

    permission_classes = [IsAuthenticated, IsSuperadminOrManager]

    def post(self, request):
        ser = SnapshotRequestSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        op_id = ser.validated_data["operator_id"]
        if op_id not in set(visible_operator_ids(request.user)):
            return Response({"detail": "Оператор не найден.", "code": "not_found"}, status=404)
        operator = Operator.objects.get(pk=op_id)
        try:
            snap = snapshot_request(actor=request.user, operator=operator)
        except SnapshotError as exc:
            return _snapshot_error(exc)
        return Response(_snapshot_payload(snap), status=status.HTTP_202_ACCEPTED)


class SnapshotDetailApi(APIView):
    permission_classes = [IsAuthenticated, IsSuperadminOrManager]

    def get(self, request, pk):
        snap = snapshot_detail(actor=request.user, pk=pk)
        if snap is None:
            return Response({"detail": "Снимок не найден."}, status=404)
        return Response(_snapshot_payload(snap))


class SnapshotImageApi(APIView):
    permission_classes = [IsAuthenticated, IsSuperadminOrManager]

    def get(self, request, pk):
        snap = snapshot_detail(actor=request.user, pk=pk)
        if snap is None or snap.status != LiveSnapshotStatus.DONE:
            return Response({"detail": "Снимка нет."}, status=404)
        data = LiveSnapshot.objects.values_list("image", flat=True).get(pk=snap.pk)
        resp = HttpResponse(bytes(data), content_type=snap.content_type or "image/jpeg")
        resp["Cache-Control"] = "private, max-age=3600"
        return resp


class SnapshotUploadApi(APIView):
    """The operator's own publisher answers a request: multipart `image`
    (JPEG), or `error` text when it could not grab a frame."""

    permission_classes = [IsAuthenticated, IsAuthenticatedAnyRole]
    parser_classes = [MultiPartParser, FormParser, JSONParser]

    def post(self, request, pk):
        profile = getattr(request.user, "profile", None)
        operator = getattr(profile, "operator", None) if profile else None
        if _role(request.user) != Role.OPERATOR or operator is None:
            return Response({"detail": "Только оператор.", "code": "forbidden"}, status=403)
        f = request.FILES.get("image")
        try:
            if f is None:
                snap = snapshot_report_error(
                    snapshot_id=pk, operator=operator, error=str(request.data.get("error") or "")[:300]
                )
            else:
                if f.size > SNAPSHOT_MAX_BYTES:
                    return Response({"detail": "Слишком большой кадр.", "code": "too_large"}, status=400)
                snap = snapshot_upload(snapshot_id=pk, operator=operator, data=f.read())
        except SnapshotError as exc:
            return _snapshot_error(exc)
        return Response({"id": str(snap.id), "status": snap.status})

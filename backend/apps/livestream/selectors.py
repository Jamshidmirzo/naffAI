"""
Read-side selectors for the livestream domain. Thin query helpers only —
anything that mutates goes in `services.py`.

Everything a manager sees is scoped by `visible_operator_ids(actor)` and
limited to this backend's room.
"""

from __future__ import annotations

import datetime as _dt
from typing import Any

from django.db.models import QuerySet
from django.utils import timezone

from apps.operators.models import Operator, OperatorStatus
from apps.users.selectors import visible_operator_ids

from .models import (
    LiveSnapshot,
    LivestreamSession,
    LivestreamSessionStatus,
    RecordingSession,
    RecordingSessionStatus,
)
from .services import room_name


def live_now_sessions(*, actor) -> QuerySet[LivestreamSession]:
    """
    Operators currently connected to our room. Rows older than 24h are
    hidden as a last resort — normally `sessions_reconcile` closes ghosts
    within seconds.
    """
    cutoff = timezone.now() - _dt.timedelta(hours=24)
    return (
        LivestreamSession.objects.select_related("operator")
        .filter(
            room_name=room_name(),
            status=LivestreamSessionStatus.LIVE,
            started_at__gte=cutoff,
            operator_id__in=visible_operator_ids(actor),
        )
        .order_by("operator__full_name", "-started_at")
    )


def _open_shift_operator_ids(operator_ids: list[int]) -> set[int]:
    from apps.attendance.models import AttendanceLog

    return set(
        AttendanceLog.objects.filter(
            operator_id__in=operator_ids, checked_out_at__isnull=True
        ).values_list("operator_id", flat=True)
    )


def livestream_candidate_operators(*, actor) -> QuerySet[Operator]:
    """Working operators the manager can see (active / trainee), flag on or
    off — the wall lists who is not on air and why, incl. «flag off»."""
    return Operator.objects.filter(
        id__in=visible_operator_ids(actor),
        status__in=[OperatorStatus.ACTIVE, OperatorStatus.TRAINEE],
    ).order_by("full_name")


def offair_reason(op: Operator, *, on_shift: bool | None = None) -> str:
    """Why an operator is not on air: disabled / inactive / paused /
    no_shift / offline (connected nowhere though nothing stops them)."""
    if not op.livestream_enabled:
        return "disabled"
    if op.status == OperatorStatus.INACTIVE:
        return "inactive"
    if op.is_paused:
        return "paused"
    if on_shift is None:
        on_shift = op.id in _open_shift_operator_ids([op.id])
    if not on_shift:
        return "no_shift"
    return "offline"


def live_now_payload(*, actor) -> dict[str, Any]:
    """
    Data for the manager's wall: who is live (one row per operator, the
    newest connection) and every other working operator with the reason
    they are not on air (disabled / paused / no_shift / offline).
    """
    sessions: dict[int, LivestreamSession] = {}
    for s in live_now_sessions(actor=actor):
        sessions.setdefault(s.operator_id, s)
    enabled = list(livestream_candidate_operators(actor=actor))
    on_shift = _open_shift_operator_ids(
        list({op.id for op in enabled} | set(sessions))
    )

    live_now = [
        {
            "id": s.id,
            "operator_id": s.operator_id,
            "operator_name": s.operator.full_name,
            "participant_identity": s.participant_identity,
            "participant_sid": s.participant_sid,
            "room_name": s.room_name,
            "started_at": s.started_at.isoformat() if s.started_at else None,
            "has_video": s.has_video,
            "on_shift": s.operator_id in on_shift,
            "is_paused": s.operator.is_paused,
        }
        for s in sessions.values()
    ]

    enabled_rows = []
    for op in enabled:
        is_live = op.id in sessions
        reason = None if is_live else offair_reason(op, on_shift=op.id in on_shift)
        enabled_rows.append(
            {
                "id": op.id,
                "full_name": op.full_name,
                "status": op.status,
                "is_live": is_live,
                "on_shift": op.id in on_shift,
                "is_paused": op.is_paused,
                "livestream_enabled": op.livestream_enabled,
                "reason": reason,
            }
        )
    return {"live_now": live_now, "enabled_operators": enabled_rows}


def recordings_queryset(
    *,
    actor,
    operator_id: int | None = None,
    date_from: _dt.date | None = None,
    date_to: _dt.date | None = None,
    only_finished: bool = True,
) -> QuerySet[RecordingSession]:
    qs = RecordingSession.objects.select_related("operator").filter(
        operator_id__in=visible_operator_ids(actor), room_name=room_name()
    )
    if only_finished:
        qs = qs.filter(status=RecordingSessionStatus.FINISHED)
    if operator_id is not None:
        qs = qs.filter(operator_id=operator_id)
    if date_from is not None:
        start_dt = timezone.make_aware(_dt.datetime.combine(date_from, _dt.time.min))
        qs = qs.filter(started_at__gte=start_dt)
    if date_to is not None:
        end_dt = timezone.make_aware(_dt.datetime.combine(date_to, _dt.time.max))
        qs = qs.filter(started_at__lte=end_dt)
    return qs.order_by("-started_at", "-id")


def recording_detail(*, actor, pk: int) -> RecordingSession | None:
    return (
        RecordingSession.objects.select_related("operator")
        .filter(pk=pk, operator_id__in=visible_operator_ids(actor))
        .first()
    )


def snapshot_detail(*, actor, pk) -> LiveSnapshot | None:
    return (
        LiveSnapshot.objects.select_related("operator")
        .defer("image")
        .filter(pk=pk, operator_id__in=visible_operator_ids(actor))
        .first()
    )

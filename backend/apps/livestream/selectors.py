"""
Read-side selectors for the livestream domain. Thin query helpers only —
anything that mutates goes in `services.py`.
"""

from __future__ import annotations

import datetime as _dt
from typing import Any

from django.db.models import QuerySet
from django.utils import timezone

from apps.operators.models import Operator, OperatorStatus

from .models import LivestreamSession, LivestreamSessionStatus, RecordingSession


def live_now_sessions() -> QuerySet[LivestreamSession]:
    """
    Operators currently publishing. We expose this to the LiveWall UI
    (manager-only). Returns active sessions started within the last 24h —
    anything older is almost certainly a lost webhook, better to hide it.
    """
    cutoff = timezone.now() - _dt.timedelta(hours=24)
    return (
        LivestreamSession.objects.select_related("operator")
        .filter(status=LivestreamSessionStatus.LIVE, started_at__gte=cutoff)
        .order_by("operator__full_name")
    )


def live_now_as_dicts() -> list[dict[str, Any]]:
    """
    Dict-serialized version for the API — avoids pulling in a serializer.
    Keep in sync with the frontend `LiveWall` tile schema.
    """
    rows = []
    for s in live_now_sessions():
        rows.append(
            {
                "id": s.id,
                "operator_id": s.operator_id,
                "operator_name": s.operator.full_name,
                "participant_identity": s.participant_identity,
                "room_name": s.room_name,
                "started_at": s.started_at.isoformat() if s.started_at else None,
            }
        )
    return rows


def livestream_enabled_operators() -> QuerySet[Operator]:
    """
    Operators with the opt-in flag ON — used to render «кто сейчас в
    эфире, а кто просто не стримит» UI tiles.
    """
    return Operator.objects.filter(
        livestream_enabled=True, status__in=[OperatorStatus.ACTIVE, OperatorStatus.TRAINEE]
    ).order_by("full_name")


def recordings_queryset(
    *,
    operator_id: int | None = None,
    date_from: _dt.date | None = None,
    date_to: _dt.date | None = None,
    only_finished: bool = True,
) -> QuerySet[RecordingSession]:
    qs = RecordingSession.objects.select_related("operator").all()
    if only_finished:
        qs = qs.filter(status="finished")
    if operator_id is not None:
        qs = qs.filter(operator_id=operator_id)
    if date_from is not None:
        start_dt = timezone.make_aware(_dt.datetime.combine(date_from, _dt.time.min))
        qs = qs.filter(started_at__gte=start_dt)
    if date_to is not None:
        end_dt = timezone.make_aware(_dt.datetime.combine(date_to, _dt.time.max))
        qs = qs.filter(started_at__lte=end_dt)
    return qs


def recording_detail(recording_id: int) -> RecordingSession | None:
    return (
        RecordingSession.objects.select_related("operator").filter(pk=recording_id).first()
    )

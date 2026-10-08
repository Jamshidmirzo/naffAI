"""
Operator livestream — data shapes only.

Two tables:
    * LivestreamSession  — one row per publisher-side live-session. Opened
      when LiveKit reports `participant_joined`; closed on
      `participant_left`. Powers the «who is live now» list on /live/wall.
    * RecordingSession  — one row per egress artifact (S3-stored mp4).
      Created on `egress_started`, finalized on `egress_ended`.

We lean on LiveKit webhooks for both tables rather than polling the server
API — webhook delivery is immediate and keeps the dashboard snappy
without any always-on worker.

Fat-model warning: do NOT add business logic here. Writes live in
`services.py`, reads in `selectors.py`.
"""

from __future__ import annotations

from django.db import models

from apps.common.models import TimestampedModel
from apps.operators.models import Operator


class LivestreamSessionStatus(models.TextChoices):
    LIVE = "live", "В эфире"
    ENDED = "ended", "Завершена"
    LOST = "lost", "Потеряна"


class LivestreamSession(TimestampedModel):
    """
    One live-session = one publisher-identity in one LiveKit room.
    `participant_identity` is the string we embed in the publisher JWT —
    `op:<operator_id>` — so webhooks can translate back to our FK.
    """

    operator = models.ForeignKey(
        Operator,
        on_delete=models.CASCADE,
        related_name="livestream_sessions",
    )
    room_name = models.CharField(max_length=64, db_index=True)
    participant_identity = models.CharField(max_length=64, db_index=True)
    started_at = models.DateTimeField(db_index=True)
    ended_at = models.DateTimeField(null=True, blank=True)
    status = models.CharField(
        max_length=16,
        choices=LivestreamSessionStatus.choices,
        default=LivestreamSessionStatus.LIVE,
        db_index=True,
    )
    # 2026-10-08: free-form hint for debugging — `participant_joined`
    # payload carries user-agent/track-count/etc, dump it here raw.
    metadata = models.JSONField(default=dict, blank=True)

    class Meta:
        indexes = [
            models.Index(fields=["status", "started_at"]),
            models.Index(fields=["operator", "started_at"]),
        ]

    def __str__(self) -> str:
        return f"{self.operator_id} · {self.participant_identity} · {self.status}"


class RecordingSessionStatus(models.TextChoices):
    PENDING = "pending", "Запускается"
    RECORDING = "recording", "Пишется"
    FINISHED = "finished", "Готова"
    FAILED = "failed", "Ошибка"
    DELETED = "deleted", "Удалена"


class RecordingSession(TimestampedModel):
    """
    One egress artifact → one row. For MVP we rely on LiveKit's
    `TrackCompositeEgress` which writes a single mp4 per publisher to S3;
    the per-chunk option (segmented HLS) is a Phase-2 upgrade.
    """

    livestream_session = models.ForeignKey(
        LivestreamSession,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="recordings",
    )
    operator = models.ForeignKey(
        Operator,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="recordings",
    )
    room_name = models.CharField(max_length=64, db_index=True)
    participant_identity = models.CharField(max_length=64, db_index=True)
    # LiveKit's egress UUID — unique, we dedupe webhooks on it.
    egress_id = models.CharField(
        max_length=64,
        unique=True,
        help_text="LiveKit egress ID (ingress for webhook idempotency).",
    )
    status = models.CharField(
        max_length=16,
        choices=RecordingSessionStatus.choices,
        default=RecordingSessionStatus.PENDING,
        db_index=True,
    )
    s3_bucket = models.CharField(max_length=128, blank=True, default="")
    s3_key = models.CharField(max_length=512, blank=True, default="")
    started_at = models.DateTimeField(null=True, blank=True)
    ended_at = models.DateTimeField(null=True, blank=True)
    duration_s = models.PositiveIntegerField(null=True, blank=True)
    size_bytes = models.BigIntegerField(null=True, blank=True)
    error_text = models.TextField(blank=True, default="")

    class Meta:
        ordering = ["-started_at", "-id"]
        indexes = [
            models.Index(fields=["operator", "started_at"]),
            models.Index(fields=["status", "started_at"]),
        ]

    def __str__(self) -> str:
        return f"{self.operator_id or '-'} · {self.egress_id} · {self.status}"


class LiveKitWebhookEvent(TimestampedModel):
    """
    Dedupe guard for webhook retries. LiveKit retries webhooks on 5xx so
    we need to filter by its `id` (per-event UUID). Keep rows 30 days.
    """

    event_id = models.CharField(max_length=128, unique=True)
    event_type = models.CharField(max_length=64, db_index=True)
    payload = models.JSONField()
    received_at = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        indexes = [
            models.Index(fields=["event_type", "received_at"]),
        ]

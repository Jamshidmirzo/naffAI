"""
ROP agent domain models.

Five tables:
- ``ROPState`` — singleton; mute cursor + last-run timestamps.
- ``DailyBriefing`` — one row per calendar day (Tashkent); stores KPI
  snapshot, LLM synthesis text, and TG delivery metadata.
- ``AlertLog`` — append-only alert history; the ``dedup_key`` + the
  trigger-specific window suppresses storms.
- ``OperatorCoachingLog`` — one row per operator per day; weaknesses +
  coaching plan derived from DB metrics (Asterisk-free).
- ``PendingApproval`` — in-prod gate for write-actions; the aiogram bot
  resolves it via inline buttons.

Design notes:
- All timestamps are UTC in the DB; services convert to Asia/Tashkent for
  display.
- ``ROPState.get_solo()`` creates the row on first access — never fails.
- ``PendingApproval`` ships with ``result_text`` so the handler can log
  what happened after approval (full action handlers come in V2).
"""

from __future__ import annotations

from django.db import models


class ROPState(models.Model):
    """Singleton — one and only row (``pk=1``) carries the agent cursor."""

    muted_until = models.DateTimeField(null=True, blank=True)
    last_briefing_at = models.DateTimeField(null=True, blank=True)
    last_pulse_at = models.DateTimeField(null=True, blank=True)
    last_evening_at = models.DateTimeField(null=True, blank=True)
    last_weekly_at = models.DateTimeField(null=True, blank=True)
    custom_prompt_additions = models.TextField(blank=True, default="")
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = "ROP state"
        verbose_name_plural = "ROP state"

    def __str__(self) -> str:
        return "ROPState"

    @classmethod
    def get_solo(cls) -> "ROPState":
        obj, _ = cls.objects.get_or_create(pk=1)
        return obj


class DailyBriefing(models.Model):
    """07:00 Tashkent briefing — one per date (Tashkent-local)."""

    date = models.DateField(unique=True, db_index=True)
    kpi_snapshot = models.JSONField(default=dict)
    synthesis_text = models.TextField(blank=True, default="")
    top_priorities = models.JSONField(default=list, blank=True)

    sent_at = models.DateTimeField(null=True, blank=True)
    tg_message_id = models.BigIntegerField(null=True, blank=True)

    model_used = models.CharField(max_length=64, blank=True, default="")
    tokens_in = models.IntegerField(default=0)
    tokens_out = models.IntegerField(default=0)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ("-date",)

    def __str__(self) -> str:
        return f"Briefing {self.date}"


class AlertLog(models.Model):
    """Append-only alert history. ``dedup_key`` suppresses storms."""

    class Priority(models.TextChoices):
        RED = "red", "Red"
        YELLOW = "yellow", "Yellow"
        GREEN = "green", "Green"
        INFO = "info", "Info"

    alert_type = models.CharField(max_length=64, db_index=True)
    priority = models.CharField(
        max_length=16, choices=Priority.choices, default=Priority.YELLOW
    )
    dedup_key = models.CharField(max_length=160, db_index=True)
    payload = models.JSONField(default=dict, blank=True)
    message_text = models.TextField(blank=True, default="")

    created_at = models.DateTimeField(auto_now_add=True, db_index=True)
    tg_message_id = models.BigIntegerField(null=True, blank=True)
    resolved_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ("-created_at",)
        indexes = [
            models.Index(fields=["alert_type", "created_at"]),
            models.Index(fields=["dedup_key", "created_at"]),
        ]

    def __str__(self) -> str:
        return f"{self.priority}:{self.alert_type} @ {self.created_at:%Y-%m-%d %H:%M}"


class OperatorCoachingLog(models.Model):
    """One per operator per day — DB-driven weakness + coaching plan."""

    operator = models.ForeignKey(
        "operators.Operator",
        on_delete=models.CASCADE,
        related_name="rop_coaching_logs",
    )
    date = models.DateField(db_index=True)
    weaknesses = models.JSONField(default=list, blank=True)
    strengths = models.JSONField(default=list, blank=True)
    coaching_plan_text = models.TextField(blank=True, default="")
    status = models.CharField(
        max_length=16,
        default="pending",
        choices=[
            ("pending", "pending"),
            ("done", "done"),
            ("skipped", "skipped"),
        ],
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ("-date", "operator_id")
        unique_together = [("operator", "date")]

    def __str__(self) -> str:
        return f"Coaching {self.operator_id} @ {self.date}"


class PendingApproval(models.Model):
    """Prod gate for every write-action — owner approves/rejects via TG."""

    class Status(models.TextChoices):
        PENDING = "pending", "Pending"
        APPROVED = "approved", "Approved"
        REJECTED = "rejected", "Rejected"
        EXPIRED = "expired", "Expired"

    action_type = models.CharField(max_length=64, db_index=True)
    action_payload = models.JSONField(default=dict, blank=True)
    description = models.TextField(blank=True, default="")

    status = models.CharField(
        max_length=16, choices=Status.choices, default=Status.PENDING, db_index=True
    )
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)
    expires_at = models.DateTimeField(db_index=True)
    resolved_at = models.DateTimeField(null=True, blank=True)
    resolved_by_tg_user_id = models.BigIntegerField(null=True, blank=True)

    tg_message_id = models.BigIntegerField(null=True, blank=True)
    result_text = models.TextField(blank=True, default="")

    class Meta:
        ordering = ("-created_at",)

    def __str__(self) -> str:
        return f"{self.action_type} [{self.status}]"

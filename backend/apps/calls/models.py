"""
Call attempts + callback reminders.

A `CallAttempt` is a single logged interaction on a lead. If the outcome
is `talked_callback`, the operator must also create a `CallbackReminder`
so the system nudges them at `remind_at`.

Reminders are supersession-based: creating a new one on the same lead
marks previous `pending` ones as `superseded`.
"""

from __future__ import annotations

from django.db import models

from apps.common.models import TimestampedModel


class CallOutcome(models.TextChoices):
    TALKED_INTERESTED = "talked_interested", "Разговор, интерес"
    TALKED_CALLBACK = "talked_callback", "Просят перезвонить"
    NO_ANSWER = "no_answer", "Не берёт трубку"
    WRONG_NUMBER = "wrong_number", "Не тот номер"
    REJECTED = "rejected", "Отказ"
    TG_ONLY = "tg_only", "Написали в Telegram"


class CallAttempt(TimestampedModel):
    lead = models.ForeignKey(
        "leads.Lead", on_delete=models.CASCADE, related_name="call_attempts"
    )
    operator = models.ForeignKey(
        "operators.Operator",
        on_delete=models.PROTECT,
        related_name="call_attempts",
    )
    outcome = models.CharField(max_length=32, choices=CallOutcome.choices)
    comment = models.TextField(blank=True, default="")

    class Meta:
        ordering = ["-created_at"]
        indexes = [
            models.Index(fields=["lead", "-created_at"]),
            models.Index(fields=["operator", "-created_at"]),
        ]

    def __str__(self) -> str:
        return f"lead#{self.lead_id} by op#{self.operator_id}: {self.outcome}"


class CallbackReminderStatus(models.TextChoices):
    PENDING = "pending", "Ожидает"
    DONE = "done", "Выполнен"
    OVERDUE = "overdue", "Просрочен"
    SNOOZED = "snoozed", "Отложен"
    SUPERSEDED = "superseded", "Заменён"


class CallbackReminder(TimestampedModel):
    """
    A reminder that operator X should call lead Y at `remind_at`.

    A lead can have at most one active (`pending` | `snoozed`) reminder at a
    time — creating a new one supersedes the previous one (see
    `apps.calls.services.callback_reminder_create`).
    """

    lead = models.ForeignKey(
        "leads.Lead", on_delete=models.CASCADE, related_name="callback_reminders"
    )
    operator = models.ForeignKey(
        "operators.Operator",
        on_delete=models.PROTECT,
        related_name="callback_reminders",
    )
    remind_at = models.DateTimeField(db_index=True)
    status = models.CharField(
        max_length=16,
        choices=CallbackReminderStatus.choices,
        default=CallbackReminderStatus.PENDING,
        db_index=True,
    )
    comment = models.TextField(blank=True, default="")
    done_at = models.DateTimeField(null=True, blank=True)
    call_attempt = models.ForeignKey(
        CallAttempt,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="callbacks",
        help_text="If this reminder was created off a call outcome, points back to it.",
    )
    dm_sent_at = models.DateTimeField(
        null=True,
        blank=True,
        help_text=(
            "Timestamp of the last Telegram DM notification. Used by "
            "`check_due_callbacks` to avoid spamming an operator's DM every "
            "cron tick after `remind_at` has passed."
        ),
    )

    class Meta:
        ordering = ["remind_at"]
        indexes = [
            models.Index(fields=["operator", "status", "remind_at"]),
            models.Index(fields=["status", "remind_at"]),
        ]

    def __str__(self) -> str:
        return (
            f"cb#{self.pk} lead#{self.lead_id} op#{self.operator_id}"
            f" @ {self.remind_at:%Y-%m-%d %H:%M} [{self.status}]"
        )

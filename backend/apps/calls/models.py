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


class CallSource(models.TextChoices):
    """
    Как звонок попал в систему.

    - `click_to_call` — оператор нажал 📞 в веб-CRM (Фаза 1 MVP).
    - `sip_originated` — исходящий через Asterisk/SIP (Фаза 2+).
    - `manual`        — задним числом руками (fallback legacy `call_attempt_log`).
    - `android_log`   — импорт из журнала звонков Android-app'а (Фаза 3+).
    """

    CLICK_TO_CALL = "click_to_call", "Click-to-call"
    SIP_ORIGINATED = "sip_originated", "SIP"
    MANUAL = "manual", "Ручной"
    ANDROID_LOG = "android_log", "Android log"


class CallAttempt(TimestampedModel):
    lead = models.ForeignKey(
        "leads.Lead", on_delete=models.CASCADE, related_name="call_attempts"
    )
    operator = models.ForeignKey(
        "operators.Operator",
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="call_attempts",
        help_text=(
            "NULL means the operator who made this call has since been deleted."
            " Row is kept so lead history stays intact."
        ),
    )
    # `outcome` теперь nullable: между `call_attempt_start` и `call_attempt_finish`
    # ряд живёт без выбранного исхода. Legacy `call_attempt_log` пишет outcome
    # сразу — обратная совместимость сохраняется.
    outcome = models.CharField(max_length=32, choices=CallOutcome.choices, blank=True, default="")
    comment = models.TextField(blank=True, default="")

    # ---- Lifecycle timestamps (Фаза 1+) ----
    # `started_at` дублирует `created_at` для ясности семантики и на случай,
    # если в будущем ряд будет создаваться заранее (например, планировщик),
    # а старт звонка произойдёт позже.
    started_at = models.DateTimeField(null=True, blank=True, db_index=True)
    answered_at = models.DateTimeField(null=True, blank=True)
    ended_at = models.DateTimeField(null=True, blank=True)
    duration_seconds = models.PositiveIntegerField(null=True, blank=True)

    # Снимок телефона лида на момент звонка. Лид может измениться (правка
    # номера, слияние), но история звонков должна показывать по какому
    # именно номеру состоялся контакт.
    phone_number = models.CharField(max_length=64, blank=True, default="")

    # ---- SIP / recording (Фаза 2+) ----
    sip_call_id = models.CharField(max_length=128, blank=True, default="", db_index=True)
    recording_url_asterisk = models.URLField(blank=True, default="")
    recording_url_mobile = models.URLField(blank=True, default="")

    source = models.CharField(
        max_length=32,
        choices=CallSource.choices,
        blank=True,
        default="",
        db_index=True,
    )

    class Meta:
        ordering = ["-created_at"]
        indexes = [
            models.Index(fields=["lead", "-created_at"]),
            models.Index(fields=["operator", "-created_at"]),
        ]

    def __str__(self) -> str:
        return f"lead#{self.lead_id} by op#{self.operator_id}: {self.outcome or 'in-progress'}"


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
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="callback_reminders",
        help_text=(
            "NULL means the assigned operator has since been deleted."
            " The reminder is kept for history but won't DM anyone."
        ),
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

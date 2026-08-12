from django.conf import settings
from django.db import models

from apps.common.models import TimestampedModel


class BotSubscription(TimestampedModel):
    """
    Legacy per-chat bot state (subscribe/unsubscribe DM daily report).
    Kept for back-compat with the pre-v2 code paths (`send_daily_manager_report`,
    the built-in asyncio daily scheduler in runner.py). The v2 flow uses
    :class:`BotChat` as the canonical registry and :class:`BotReport` as
    the scheduling primitive.
    """

    LANGUAGE_CHOICES = [("ru", "Русский"), ("uz", "Oʻzbekcha")]

    chat_id = models.BigIntegerField(unique=True)
    chat_title = models.CharField(max_length=128, blank=True, default="")
    is_active = models.BooleanField(default=False)
    language = models.CharField(max_length=4, choices=LANGUAGE_CHOICES, default="ru")
    blocked_at = models.DateTimeField(null=True, blank=True)
    last_daily_report_date = models.DateField(null=True, blank=True)

    class Meta:
        ordering = ["-created_at"]

    def __str__(self) -> str:
        return f"chat#{self.chat_id} {self.chat_title} ({self.language})"


class BotChatKind(models.TextChoices):
    PRIVATE = "private", "Приват"
    GROUP = "group", "Группа"
    SUPERGROUP = "supergroup", "Супергруппа"
    CHANNEL = "channel", "Канал"


class BotChat(TimestampedModel):
    """
    Registry of every chat the bot is aware of — private DMs (auto-registered
    on first /start) and groups/supergroups/channels (auto-registered when
    the bot receives a `my_chat_member` event that adds it there).

    Used as the source list for BotReport.recipients in the v2 UI and to
    gate which data blocks a chat may receive (groups can't get manager-
    sensitive blocks like payroll or per-operator financials).
    """

    LANGUAGE_CHOICES = BotSubscription.LANGUAGE_CHOICES

    chat_id = models.BigIntegerField(unique=True, db_index=True)
    kind = models.CharField(max_length=16, choices=BotChatKind.choices)
    title = models.CharField(max_length=256, blank=True, default="")
    linked_profile = models.ForeignKey(
        "users.Profile",
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="bot_chats",
        help_text="For private chats: which app-user this DM belongs to (set via /link).",
    )
    language = models.CharField(max_length=4, choices=LANGUAGE_CHOICES, default="uz")
    is_active = models.BooleanField(default=True, db_index=True)
    blocked_at = models.DateTimeField(null=True, blank=True)
    last_seen_at = models.DateTimeField(auto_now=True)

    class Meta:
        indexes = [models.Index(fields=["kind", "is_active"])]
        ordering = ["-last_seen_at"]

    def __str__(self) -> str:
        return f"{self.kind}#{self.chat_id} {self.title}"


class BotReportPeriod(models.TextChoices):
    TODAY = "today", "Сегодня"
    YESTERDAY = "yesterday", "Вчера"
    WEEK = "week", "Неделя"
    MONTH = "month", "Месяц"


class BotReport(TimestampedModel):
    """
    UI-configurable scheduled report.

    The `blocks` JSON is a list of slugs from `report_blocks.BLOCKS` (e.g.
    ["sales_total", "top_operators", "daily_quote"]). Each block is rendered
    independently and joined; blocks marked as manager-sensitive are stripped
    when the recipient chat is a group/channel.

    `schedule_days` is a list of ISO weekday abbreviations (mon..sun); an
    empty list means "every day".

    Idempotency: `last_sent_at.date()` guards against re-sending the same
    day if the minutely cron fires multiple times within the schedule window.
    """

    LANGUAGE_CHOICES = BotSubscription.LANGUAGE_CHOICES

    name = models.CharField(max_length=128)
    enabled = models.BooleanField(default=True, db_index=True)
    schedule_time = models.TimeField(
        help_text="HH:MM in Asia/Tashkent when the report should fire."
    )
    schedule_days = models.JSONField(
        default=list,
        blank=True,
        help_text='List of weekday keys ["mon","tue",...]; empty = every day.',
    )
    recipients = models.ManyToManyField(
        BotChat, related_name="reports", blank=True
    )
    blocks = models.JSONField(default=list, blank=True)
    language = models.CharField(max_length=4, choices=LANGUAGE_CHOICES, default="uz")
    period = models.CharField(
        max_length=16, choices=BotReportPeriod.choices, default=BotReportPeriod.TODAY
    )
    include_header = models.BooleanField(default=True)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="created_bot_reports",
    )
    last_sent_at = models.DateTimeField(null=True, blank=True)
    last_send_error = models.TextField(blank=True, default="")

    class Meta:
        ordering = ["-created_at"]

    def __str__(self) -> str:
        return f"{self.name} ({self.schedule_time})"


class BotAuditLog(models.Model):
    """
    Append-only log of every bot interaction. Written by the aiogram
    AuditMiddleware before each handler dispatch; the handler updates
    outcome/error_detail on completion.

    Retained for 30 days by a cleanup cron (out of scope MVP).
    """

    at = models.DateTimeField(auto_now_add=True, db_index=True)
    chat_id = models.BigIntegerField(db_index=True)
    chat_kind = models.CharField(max_length=16, blank=True, default="")
    tg_user_id = models.BigIntegerField(null=True, blank=True, db_index=True)
    username = models.CharField(max_length=64, blank=True, default="")
    linked_operator_id = models.BigIntegerField(null=True, blank=True)
    command = models.CharField(max_length=64)
    args = models.TextField(blank=True, default="")
    outcome = models.CharField(
        max_length=32,
        default="ok",
        choices=[
            ("ok", "ok"),
            ("denied", "denied"),
            ("error", "error"),
            ("unlinked", "unlinked"),
            ("scheduled_sent", "scheduled_sent"),
        ],
    )
    error_detail = models.TextField(blank=True, default="")

    class Meta:
        ordering = ["-at"]
        indexes = [
            models.Index(fields=["chat_id", "-at"]),
            models.Index(fields=["command", "-at"]),
        ]

    def __str__(self) -> str:
        return f"{self.at:%Y-%m-%d %H:%M} chat#{self.chat_id} {self.command} → {self.outcome}"

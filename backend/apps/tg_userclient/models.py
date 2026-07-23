from django.db import models

from apps.common.models import TimestampedModel


class TgSessionStatus(models.TextChoices):
    PENDING_CODE = "pending_code", "Ожидает код"
    PENDING_2FA = "pending_2fa", "Ожидает облачный пароль"
    ACTIVE = "active", "Активна"
    EXPIRED = "expired", "Истекла"
    REVOKED = "revoked", "Отозвана"
    ERROR = "error", "Ошибка"


class TgSession(TimestampedModel):
    operator = models.OneToOneField(
        "operators.Operator",
        on_delete=models.CASCADE,
        related_name="tg_session",
    )
    phone = models.CharField(max_length=20)
    phone_code_hash = models.CharField(max_length=64, blank=True, default="")
    encrypted_session = models.BinaryField(blank=True, default=b"")
    key_version = models.PositiveSmallIntegerField(
        default=1,
        help_text=(
            "Which key from TG_SESSION_ENCRYPTION_KEYS was used to encrypt "
            "encrypted_session. Read alongside so we can rotate the master "
            "key without invalidating old rows."
        ),
    )
    tg_user_id = models.BigIntegerField(null=True, blank=True)
    tg_username = models.CharField(max_length=64, blank=True, default="")
    status = models.CharField(
        max_length=16,
        choices=TgSessionStatus.choices,
        default=TgSessionStatus.PENDING_CODE,
    )
    consent_at = models.DateTimeField(null=True, blank=True)
    last_connected_at = models.DateTimeField(null=True, blank=True)
    last_error = models.TextField(blank=True, default="")

    class Meta:
        verbose_name = "TG-сессия"
        verbose_name_plural = "TG-сессии"

    def __str__(self) -> str:
        return f"TgSession#{self.pk} op={self.operator_id} [{self.status}]"


class TgChatKind(models.TextChoices):
    PRIVATE = "private", "Личный"
    GROUP = "group", "Группа"
    CHANNEL = "channel", "Канал"


class TgChat(TimestampedModel):
    session = models.ForeignKey(
        TgSession, on_delete=models.CASCADE, related_name="chats"
    )
    tg_chat_id = models.BigIntegerField()
    kind = models.CharField(max_length=8, choices=TgChatKind.choices)
    title = models.CharField(max_length=200, blank=True, default="")
    partner_name = models.CharField(max_length=200, blank=True, default="")
    partner_phone = models.CharField(max_length=20, blank=True, default="")
    lead = models.ForeignKey(
        "leads.Lead",
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="tg_chats",
    )
    last_message_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        unique_together = [("session", "tg_chat_id")]
        verbose_name = "TG-чат"
        verbose_name_plural = "TG-чаты"

    def __str__(self) -> str:
        label = self.title or self.partner_name or str(self.tg_chat_id)
        return f"TgChat#{self.pk} {label}"


class TgMessageDirection(models.TextChoices):
    IN = "in", "Входящее"
    OUT = "out", "Исходящее"


class TgMessageKind(models.TextChoices):
    TEXT = "text", "Текст"
    VOICE = "voice", "Голосовое"
    PHOTO = "photo", "Фото"
    VIDEO = "video", "Видео"
    STICKER = "sticker", "Стикер"
    OTHER = "other", "Другое"


class TgMessage(models.Model):
    chat = models.ForeignKey(
        TgChat, on_delete=models.CASCADE, related_name="messages"
    )
    tg_message_id = models.BigIntegerField()
    direction = models.CharField(
        max_length=3, choices=TgMessageDirection.choices
    )
    kind = models.CharField(max_length=8, choices=TgMessageKind.choices)
    text = models.TextField(blank=True, default="")
    transcript_status = models.CharField(max_length=16, blank=True, default="")
    voice_duration_sec = models.IntegerField(null=True, blank=True)
    sent_at = models.DateTimeField(db_index=True)
    ingested_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        unique_together = [("chat", "tg_message_id")]
        indexes = [
            models.Index(fields=["chat", "sent_at"]),
        ]
        verbose_name = "TG-сообщение"
        verbose_name_plural = "TG-сообщения"

    def __str__(self) -> str:
        return f"TgMessage#{self.pk} chat={self.chat_id} [{self.direction}]"


class TgAiInsight(TimestampedModel):
    session = models.ForeignKey(
        TgSession, on_delete=models.CASCADE, related_name="insights"
    )
    chat = models.ForeignKey(
        TgChat,
        null=True,
        blank=True,
        on_delete=models.CASCADE,
        related_name="insights",
    )
    since = models.DateTimeField()
    until = models.DateTimeField()
    model_version = models.CharField(max_length=64)
    prompt_version = models.CharField(max_length=32)
    summary = models.TextField()
    quality_score = models.IntegerField(null=True, blank=True)
    red_flags = models.JSONField(default=list)
    highlights = models.JSONField(default=list)
    provider_used = models.CharField(max_length=32, blank=True, default="")

    class Meta:
        indexes = [
            models.Index(fields=["session", "until"]),
            models.Index(fields=["chat", "until"]),
        ]
        verbose_name = "TG AI-инсайт"
        verbose_name_plural = "TG AI-инсайты"

    def __str__(self) -> str:
        target = f"chat={self.chat_id}" if self.chat_id else "operator-wide"
        return f"TgAiInsight#{self.pk} {target} score={self.quality_score}"


class TgBackfillJobStatus(models.TextChoices):
    PENDING = "pending", "Ожидает"
    RUNNING = "running", "В работе"
    DONE = "done", "Готово"
    ERROR = "error", "Ошибка"


class TgBackfillJob(TimestampedModel):
    session = models.ForeignKey(
        TgSession, on_delete=models.CASCADE, related_name="backfill_jobs"
    )
    since = models.DateTimeField()
    status = models.CharField(
        max_length=8,
        choices=TgBackfillJobStatus.choices,
        default=TgBackfillJobStatus.PENDING,
    )
    started_at = models.DateTimeField(null=True, blank=True)
    finished_at = models.DateTimeField(null=True, blank=True)
    chats_scanned = models.IntegerField(default=0)
    messages_saved = models.IntegerField(default=0)
    last_error = models.TextField(blank=True, default="")

    class Meta:
        indexes = [models.Index(fields=["session", "status"])]
        verbose_name = "TG Backfill Job"
        verbose_name_plural = "TG Backfill Jobs"

    def __str__(self) -> str:
        return f"TgBackfillJob#{self.pk} session={self.session_id} [{self.status}]"


class TgAiInsightAttemptStatus(models.TextChoices):
    SUCCESS = "success", "Успешно"
    ERROR_RETRIABLE = "error_retriable", "Ошибка (повторить)"
    ERROR_PERMANENT = "error_permanent", "Ошибка (неустранимая)"


class TgAiInsightAttempt(models.Model):
    chat = models.ForeignKey(
        TgChat, on_delete=models.CASCADE, related_name="ai_attempts"
    )
    session = models.ForeignKey(
        TgSession, on_delete=models.CASCADE, related_name="ai_attempts"
    )
    attempted_at = models.DateTimeField(auto_now_add=True)
    status = models.CharField(
        max_length=20, choices=TgAiInsightAttemptStatus.choices
    )
    error_message = models.TextField(blank=True, default="")
    next_retry_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        indexes = [
            models.Index(fields=["chat", "attempted_at"]),
            models.Index(fields=["status", "next_retry_at"]),
        ]
        verbose_name = "TG AI Attempt"
        verbose_name_plural = "TG AI Attempts"

    def __str__(self) -> str:
        return f"TgAiInsightAttempt#{self.pk} chat={self.chat_id} [{self.status}]"


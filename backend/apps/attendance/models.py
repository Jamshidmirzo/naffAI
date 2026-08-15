from django.conf import settings
from django.db import models
from django.core.validators import MinValueValidator, MaxValueValidator
from apps.common.models import TimestampedModel


class OperatorQr(TimestampedModel):
    """One active QR per operator. Prints on badges / downloads as PNG.

    Lasts indefinitely until rotated by a Team Lead.
    """

    operator = models.ForeignKey(
        "operators.Operator",
        on_delete=models.CASCADE,
        related_name="attendance_qrs",
    )
    nonce = models.CharField(
        max_length=32,
        unique=True,
        help_text="16 hex bytes (32 characters). Enters HMAC signature.",
    )
    revoked_at = models.DateTimeField(null=True, blank=True)
    revoked_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="+",
    )

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["operator"],
                condition=models.Q(revoked_at__isnull=True),
                name="uniq_active_qr_per_operator",
            ),
        ]
        indexes = [models.Index(fields=["nonce"])]


class AttendanceLog(TimestampedModel):
    """A single shift session. Only one open shift allowed per operator.

    Closed by either rescan (check-out) or auto-closing timer.
    """

    operator = models.ForeignKey(
        "operators.Operator",
        on_delete=models.CASCADE,
        related_name="attendance_logs",
    )
    checked_in_at = models.DateTimeField(db_index=True)
    checked_out_at = models.DateTimeField(null=True, blank=True)
    checked_in_ip = models.GenericIPAddressField(null=True, blank=True)
    checked_out_ip = models.GenericIPAddressField(null=True, blank=True)
    checked_in_user_agent = models.CharField(max_length=256, blank=True, default="")
    checked_out_user_agent = models.CharField(max_length=256, blank=True, default="")
    auto_closed = models.BooleanField(default=False)
    was_late = models.BooleanField(
        default=False,
        help_text="Set at check-in time: True if checked_in_at > shift_start + late_threshold_min",
    )
    token_key = models.CharField(max_length=64, blank=True, default="")
    source = models.CharField(
        max_length=16,
        choices=[("qr", "qr"), ("tg", "tg"), ("manual", "manual")],
        default="qr",
        help_text="Channel used to record the event",
    )
    long_shift_warning_sent_at = models.DateTimeField(
        null=True,
        blank=True,
        help_text="Момент отправки предупреждения о длинной смене — защита от повторов",
    )
    warning_dismissed_at = models.DateTimeField(
        null=True,
        blank=True,
        help_text="Оператор нажал 'Нет, продолжаю' — не шлём повтор",
    )
    manually_closed = models.BooleanField(default=False)
    manually_closed_by = models.ForeignKey(
        "auth.User",
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="+",
        help_text="Кто из TL/Manager закрыл смену руками",
    )
    manual_close_note = models.CharField(max_length=280, blank=True, default="")
    # 2026-08-14: photo confirmation — фото и его perceptual hash. Хранение
    # 30 дней (cron cleanup_attendance_photos), логи остаются вечно.
    checkin_photo = models.ImageField(
        upload_to="attendance/%Y/%m/",
        null=True,
        blank=True,
        help_text="Фото при check-in (обнуляется через 30 дней)",
    )
    checkout_photo = models.ImageField(
        upload_to="attendance/%Y/%m/",
        null=True,
        blank=True,
        help_text="Фото при check-out (обнуляется через 30 дней)",
    )
    checkin_photo_phash = models.CharField(
        max_length=16,
        blank=True,
        default="",
        db_index=True,
        help_text="Perceptual hash фото — анти-дубль на 24ч",
    )
    checkout_photo_phash = models.CharField(
        max_length=16,
        blank=True,
        default="",
        db_index=True,
    )

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["operator"],
                condition=models.Q(checked_out_at__isnull=True),
                name="uniq_open_log_per_operator",
            ),
        ]
        indexes = [
            models.Index(fields=["operator", "-checked_in_at"]),
            models.Index(fields=["checked_in_at"]),
        ]

    @property
    def duration_seconds(self) -> int | None:
        if self.checked_out_at is None:
            return None
        return int((self.checked_out_at - self.checked_in_at).total_seconds())


class AttendancePinSession(models.Model):
    """
    Отметка «менеджер ввёл attendance-PIN в этой сессии».

    Один row per User. При успешном verify обновляем `verified_at=now()`.
    Permission-класс `IsAttendancePinVerified` пропускает менеджера, если
    `now() - verified_at <= PIN_TTL` (30 минут). Superadmin PIN'a не имеет —
    его сессия здесь не нужна.
    """

    user = models.OneToOneField(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="attendance_pin_session",
    )
    verified_at = models.DateTimeField()

    def __str__(self) -> str:
        return f"pin_session<{self.user_id}>"


class AttendanceSettings(models.Model):
    """Singleton configuration storing schedule and telegram toggles."""

    shift_start = models.TimeField(default="10:00")
    shift_end = models.TimeField(default="20:00")
    late_threshold_min = models.PositiveSmallIntegerField(
        default=15,
        validators=[MinValueValidator(0), MaxValueValidator(240)],
    )
    auto_close_at = models.TimeField(default="23:00")
    tg_checkin_enabled = models.BooleanField(
        default=True,
        help_text="Allows check-in/out via Telegram bot commands",
    )
    long_shift_warning_hours = models.PositiveSmallIntegerField(
        default=10,
        help_text="После скольких часов открытой смены слать warning",
    )
    # 2026-08-14 attendance redesign — фото-подтверждение и face-check.
    # По умолчанию require_photo=False → обратная совместимость (prod поведение
    # не меняется, включить можно PATCH /api/attendance/settings/).
    require_photo = models.BooleanField(
        default=False,
        help_text="Требовать фото при каждом скане (иначе фото опционально)",
    )
    require_face = models.BooleanField(
        default=True,
        help_text="Если фото передано — проверять наличие лица (MediaPipe)",
    )
    photo_max_size_mb = models.PositiveSmallIntegerField(
        default=5,
        help_text="Лимит размера фото в мегабайтах",
    )
    updated_at = models.DateTimeField(auto_now=True)
    updated_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
    )

    class Meta:
        constraints = [
            models.CheckConstraint(check=models.Q(pk=1), name="attendance_settings_singleton"),
        ]

    def save(self, *args, **kwargs):
        self.pk = 1
        super().save(*args, **kwargs)

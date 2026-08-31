from decimal import Decimal

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
    # 2026-08-26 enforcement wave.
    # Спам-защита для reminder'a об уходе (см. attendance_checkout_reminder
    # cron): один DM/баннер на смену — как только выставлено, повторный
    # запуск команды пропускает лог.
    checkout_reminder_sent_at = models.DateTimeField(
        null=True,
        blank=True,
        help_text="Момент отправки reminder'a «прошло 8 часов, отметьтесь об уходе».",
    )
    # Заполняется, когда оператор задним числом ввёл `checked_out_at`
    # через POST /api/attendance/me/backfill-checkout/. `auto_closed`
    # при этом НЕ сбрасывается — сохраняем аудит («cron закрыл в 23:00»),
    # а `checked_out_at` уже показывает реальный уход. Для «forgotten
    # checkouts count» селектор берёт auto_closed=True AND
    # backfilled_by_operator_at IS NULL — так после backfill лог перестаёт
    # считаться «забытым».
    backfilled_by_operator_at = models.DateTimeField(
        null=True,
        blank=True,
        help_text="Момент, когда оператор ввёл фактическое время ухода задним числом.",
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
            # Wave-1 (2026-08-22): open_log_for_operator фильтрует
            # `operator=… AND checked_out_at IS NULL` — этот составной
            # индекс превращает full scan по частичному uniq в направленный
            # lookup. Не заменяет partial uniq (тот про целостность), лишь
            # ускоряет hot-path.
            models.Index(
                fields=["operator", "checked_out_at"],
                name="attlog_op_checkedout_idx",
            ),
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
    # 2026-08-26 enforcement wave.
    # После скольких часов от **личного** check-in слать оператору мягкий
    # reminder «не забудьте отметиться об уходе» (TG DM + in-app баннер).
    # Cron `attendance_checkout_reminder` крутится каждые 15 минут и
    # ставит `AttendanceLog.checkout_reminder_sent_at` — спам-защита.
    checkout_reminder_after_hours = models.PositiveSmallIntegerField(
        default=8,
        help_text="После скольких часов от check-in слать reminder об уходе (0 = выкл).",
    )
    # Верхняя граница «во сколько вы вчера ушли?» — backfill-endpoint
    # отклоняет значения `> checked_in_at + N часов`. Держим отдельно
    # от long_shift_warning_hours, чтобы менеджер мог настроить более
    # либеральный порог для forgotten-checkout backfill (реальные смены
    # могут длиться дольше warning-порога).
    max_backfill_hours = models.PositiveSmallIntegerField(
        default=14,
        help_text="Максимальная длительность смены при backfill забытого ухода.",
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
    # 2026-08-15: global attendance PIN. Один общий PIN на всех менеджеров —
    # ставит и сбрасывает только суперадмин. Хеш (make_password), пустой →
    # PIN не задан → менеджеры не могут пройти в раздел, пока superadmin
    # не задаст. Superadmin PIN'a не требует. См. `apps.attendance.pin_services`.
    pin_hash = models.CharField(
        max_length=128,
        blank=True,
        default="",
        help_text="Django password-hash 4-значного глобального PIN'a. Пусто = PIN не задан.",
    )
    pin_updated_at = models.DateTimeField(
        null=True,
        blank=True,
        help_text="Момент последнего set/reset глобального PIN'a.",
    )
    pin_updated_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="+",
        help_text="Superadmin, задавший/сбросивший PIN.",
    )
    # 2026-08-31: payroll-defaults (см. модуль `apps.attendance.selectors::
    # attendance_payroll_summary`). Хранятся здесь, чтобы менеджер мог одним
    # PATCH'ем переопределить сразу для всех операторов — а конкретный
    # оператор оставался с полем-override'ом на своей карточке.
    default_salary_uzs = models.DecimalField(
        max_digits=12,
        decimal_places=0,
        default=Decimal("1500000"),
        help_text="Оклад по умолчанию (UZS). Если у оператора `salary_uzs` пусто — берётся отсюда.",
    )
    default_grace_period_min = models.PositiveSmallIntegerField(
        default=20,
        validators=[MinValueValidator(0), MaxValueValidator(240)],
        help_text="Grace-минуты после `shift_start` — приход в этом окне НЕ считается опозданием (payroll).",
    )
    default_late_penalty_uzs = models.DecimalField(
        max_digits=10,
        decimal_places=0,
        default=Decimal("50000"),
        help_text="Фиксированный штраф за каждое опоздание сверх grace (UZS).",
    )
    default_weekly_day_off = models.PositiveSmallIntegerField(
        default=6,
        validators=[MinValueValidator(0), MaxValueValidator(6)],
        help_text="Личный выходной по умолчанию (0=Пн … 6=Вс).",
    )
    default_attendance_gate_pct = models.PositiveSmallIntegerField(
        default=85,
        validators=[MinValueValidator(0), MaxValueValidator(100)],
        help_text="Если посещаемость <N%% в месяце — оклад НЕ начисляется (только комиссия).",
    )
    default_weekly_free_absences = models.PositiveSmallIntegerField(
        default=1,
        validators=[MinValueValidator(0), MaxValueValidator(7)],
        help_text="Сколько пропусков в неделю «прощаются» без штрафа (сверх личного выходного).",
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

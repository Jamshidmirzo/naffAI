from django.core.validators import MaxValueValidator, MinValueValidator
from django.db import models

from apps.common.models import TimestampedModel


class OperatorStatus(models.TextChoices):
    ACTIVE = "active", "Активен"
    TRAINEE = "trainee", "Стажёр"
    INACTIVE = "inactive", "Неактивен"


class Operator(TimestampedModel):
    full_name = models.CharField(max_length=128)
    # Рабочий номер — используется для логина, TG-подключения,
    # уведомлений. Обязателен перед созданием учётки и TG-сессии.
    phone = models.CharField(
        max_length=32,
        blank=True,
        default="",
        help_text="Рабочий номер (+998XXXXXXXXX). Используется для входа и Telegram.",
    )
    # Личный номер — только для менеджерских контактов, необязателен.
    personal_phone = models.CharField(
        max_length=32,
        blank=True,
        default="",
        help_text="Личный номер оператора. Опционально.",
    )
    status = models.CharField(
        max_length=16, choices=OperatorStatus.choices, default=OperatorStatus.ACTIVE
    )
    hired_at = models.DateField(null=True, blank=True)
    note = models.TextField(blank=True, default="")
    daily_lesson_opt_out = models.BooleanField(default=False)
    # Per-operator opt-in для morning-gate блокировки (спец-лиды + callback).
    # Глобальный switch `SystemSetting.morning_gate_enabled` включён по
    # умолчанию, но **применяется** только к операторам с этим флагом.
    # Deux-этажный контроль даёт возможность обкатать блокировку на
    # выборке (demo/тестовые операторы), не выключая её глобально.
    # По умолчанию False — новые операторы «prod-безопасны» и никогда
    # не блокируются, пока менеджер явно не включит флаг.
    blocking_gate_enabled = models.BooleanField(
        default=False,
        help_text=(
            "Применять блокировку RR по спец-лидам и просроченным колбэкам. "
            "По умолчанию OFF — оператор получает новых лидов без гейта. "
            "Включайте для тестовых операторов или после обучения."
        ),
    )
    # Per-operator opt-in для UI-гейта check-in (2026-08-26).
    # Когда True — фронт показывает fullscreen «Отметьтесь чтобы работать»
    # для этого оператора при отсутствии open AttendanceLog. Backend
    # никакие endpoints не блокирует — enforcement только на UI. По
    # умолчанию False, чтобы включать выборочно (demo / после обучения).
    require_checkin_enabled = models.BooleanField(
        default=False,
        help_text=(
            "UI-гейт: показывать оператору блокирующий модал «Отметьтесь чтобы работать» "
            "пока open AttendanceLog не создан. Backend API остаётся открытым. "
            "По умолчанию OFF — включайте выборочно для обкатки."
        ),
    )
    # День рождения оператора — ДД.ММ.ГГГГ. Год виден только менеджеру
    # в карточке; в общем UI показываем только ДД.ММ. По умолчанию NULL
    # — новые операторы «prod-безопасны» и никаких уведомлений/баннеров
    # не получают, пока сами (через профиль) или менеджер не заполнят
    # дату. `birthday_notify` cron идёт только по тем, у кого дата
    # заполнена и совпадает с сегодняшним днём/месяцем.
    birth_date = models.DateField(
        null=True,
        blank=True,
        help_text=(
            "Дата рождения оператора (ДД.ММ.ГГГГ). Год виден только "
            "менеджерам в карточке; в остальном UI — только день и месяц."
        ),
    )
    # Idempotency-guard для `manage.py birthday_notify` — записываем сюда
    # `today` после успешной отправки поздравления. Повторный запуск
    # cron'a в тот же день (рестарт сервера, ручной run) пропустит этого
    # оператора и не задублирует Notification/DM менеджерам.
    birthday_notified_on = models.DateField(
        null=True,
        blank=True,
        help_text=(
            "Idempotency: дата, за которую уже разослали поздравление "
            "менеджерам. Пустое → cron ещё не отправлял в этом году. "
            "Guards от дублей при рестарте / ручном повторном запуске."
        ),
    )
    # 2026-08-31: payroll overrides. Все поля nullable — при пустом
    # значении расчёт зарплаты (`apps.attendance.selectors::
    # attendance_payroll_summary`) берёт `AttendanceSettings.default_*`.
    # Даёт менеджеру гибкость («у Ойбека студенческий график с 14:00,
    # оклад 800к, вместо 10:00/1.5M») без правки общих настроек.
    salary_uzs = models.DecimalField(
        max_digits=12,
        decimal_places=0,
        null=True,
        blank=True,
        help_text="Оклад оператора в UZS. Пусто → default_salary_uzs из настроек.",
    )
    shift_start = models.TimeField(
        null=True,
        blank=True,
        help_text="Персональное начало смены. Пусто → shift_start из настроек.",
    )
    shift_end = models.TimeField(
        null=True,
        blank=True,
        help_text="Персональный конец смены. Пусто → shift_end из настроек.",
    )
    grace_period_min = models.PositiveSmallIntegerField(
        null=True,
        blank=True,
        validators=[MinValueValidator(0), MaxValueValidator(240)],
        help_text="Персональный grace для опозданий (мин). Пусто → default_grace_period_min.",
    )
    late_penalty_uzs = models.DecimalField(
        max_digits=10,
        decimal_places=0,
        null=True,
        blank=True,
        help_text="Персональный фикс. штраф за опоздание (UZS). Пусто → default_late_penalty_uzs.",
    )
    weekly_day_off = models.PositiveSmallIntegerField(
        null=True,
        blank=True,
        validators=[MinValueValidator(0), MaxValueValidator(6)],
        help_text="Персональный выходной день (0=Пн … 6=Вс). Пусто → default_weekly_day_off.",
    )
    weekly_free_absences = models.PositiveSmallIntegerField(
        null=True,
        blank=True,
        validators=[MinValueValidator(0), MaxValueValidator(7)],
        help_text="Персональный лимит «прощённых» пропусков в неделю. Пусто → default_weekly_free_absences.",
    )

    class Meta:
        ordering = ["full_name"]
        indexes = [models.Index(fields=["status"])]

    def __str__(self) -> str:
        return self.full_name

    def is_birthday_today(self, today=None) -> bool:
        """
        True если сегодняшняя дата (в текущем локальном TZ) совпадает
        с day/month у `birth_date`. Год игнорируется — важно только,
        что «сегодня твой день рождения». 29 февраля в невисокосный
        год трактуем как 28 февраля (см. `birthday_matches_today`
        в selectors для той же логики на уровне QuerySet).
        """
        if self.birth_date is None:
            return False
        from django.utils import timezone as _tz

        if today is None:
            today = _tz.localdate()
        bd = self.birth_date
        # 29 февраля именинник в невисокосный год празднует 28 февраля.
        try:
            import calendar as _cal

            if bd.month == 2 and bd.day == 29 and not _cal.isleap(today.year):
                return today.month == 2 and today.day == 28
        except Exception:
            pass
        return bd.month == today.month and bd.day == today.day


class OperatorMonthlyPlan(TimestampedModel):
    operator = models.ForeignKey(Operator, on_delete=models.CASCADE, related_name="monthly_plans")
    year = models.PositiveSmallIntegerField()
    month = models.PositiveSmallIntegerField()
    target_amount = models.DecimalField(max_digits=16, decimal_places=2)

    class Meta:
        unique_together = ("operator", "year", "month")

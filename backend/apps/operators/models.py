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

    class Meta:
        ordering = ["full_name"]
        indexes = [models.Index(fields=["status"])]

    def __str__(self) -> str:
        return self.full_name


class OperatorMonthlyPlan(TimestampedModel):
    operator = models.ForeignKey(Operator, on_delete=models.CASCADE, related_name="monthly_plans")
    year = models.PositiveSmallIntegerField()
    month = models.PositiveSmallIntegerField()
    target_amount = models.DecimalField(max_digits=16, decimal_places=2)

    class Meta:
        unique_together = ("operator", "year", "month")

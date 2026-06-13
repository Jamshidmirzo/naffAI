from django.db import models

from apps.common.models import TimestampedModel


class PayoutType(models.TextChoices):
    FIXED = "fixed", "Фиксированный бонус"
    PERCENT = "percent", "Процент от суммы сверх порога"
    TIERS = "tiers", "Прогрессивные тиры"


class PayrollScope(models.TextChoices):
    GLOBAL = "global", "Глобальное правило"
    OPERATOR = "operator", "Правило оператора"


class PayrollRule(TimestampedModel):
    """
    Threshold-based payroll. Default: 50,000,000 UZS/month, 3% above threshold.

    For `tiers`: store a JSON like
        [{"from": 50000000, "rate_percent": 3},
         {"from": 80000000, "rate_percent": 5},
         {"from": 120000000, "rate_percent": 7}]
    """

    scope = models.CharField(
        max_length=16, choices=PayrollScope.choices, default=PayrollScope.GLOBAL
    )
    operator = models.ForeignKey(
        "operators.Operator",
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name="payroll_rules",
    )
    threshold = models.DecimalField(max_digits=14, decimal_places=2, default=50_000_000)
    payout_type = models.CharField(
        max_length=16, choices=PayoutType.choices, default=PayoutType.PERCENT
    )
    payout_value = models.DecimalField(max_digits=14, decimal_places=2, default=3)
    tiers = models.JSONField(default=list, blank=True)
    period = models.CharField(max_length=16, default="month")
    is_active = models.BooleanField(default=True)

    class Meta:
        ordering = ["scope", "operator_id"]
        constraints = [
            models.UniqueConstraint(
                fields=["operator"],
                condition=models.Q(scope="operator", is_active=True),
                name="uniq_active_operator_rule",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.get_scope_display()} #{self.id}"

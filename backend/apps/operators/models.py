from django.db import models

from apps.common.models import TimestampedModel


class OperatorStatus(models.TextChoices):
    ACTIVE = "active", "Активен"
    TRAINEE = "trainee", "Стажёр"
    INACTIVE = "inactive", "Неактивен"


class Operator(TimestampedModel):
    full_name = models.CharField(max_length=128)
    phone = models.CharField(max_length=32, blank=True, default="")
    status = models.CharField(
        max_length=16, choices=OperatorStatus.choices, default=OperatorStatus.ACTIVE
    )
    hired_at = models.DateField(null=True, blank=True)
    note = models.TextField(blank=True, default="")

    class Meta:
        ordering = ["full_name"]
        indexes = [models.Index(fields=["status"])]

    def __str__(self) -> str:
        return self.full_name

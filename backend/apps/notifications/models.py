"""
Thin in-app notification model. One row per recipient — bulk-created by
`services.notification_broadcast` so a single event (e.g. new sale) fans
out to every senior user without any read-side joins.
"""

from django.conf import settings
from django.db import models

from apps.common.models import TimestampedModel


class NotificationKind(models.TextChoices):
    SALE_CREATED = "sale_created", "Новая продажа"
    SALE_RETURNED = "sale_returned", "Возврат продажи"
    SALE_REJECTED = "sale_rejected", "Продажа отклонена"
    CALLBACK_OVERDUE = "callback_overdue", "Просроченный колбэк"
    LEAD_ASSIGNED = "lead_assigned", "Новый лид"
    SYSTEM = "system", "Системное сообщение"


class Notification(TimestampedModel):
    recipient = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="notifications",
    )
    kind = models.CharField(
        max_length=32, choices=NotificationKind.choices, db_index=True
    )
    title = models.CharField(max_length=280)
    body = models.TextField(blank=True, default="")
    link = models.CharField(
        max_length=512,
        blank=True,
        default="",
        help_text="Relative frontend URL, e.g. /sales/123",
    )
    read_at = models.DateTimeField(null=True, blank=True, db_index=True)
    metadata = models.JSONField(default=dict, blank=True)

    class Meta:
        ordering = ["-created_at"]
        indexes = [
            models.Index(fields=["recipient", "-created_at"]),
            models.Index(fields=["recipient", "read_at"]),
        ]

    def __str__(self) -> str:
        return f"[{self.kind}] {self.title} → user#{self.recipient_id}"

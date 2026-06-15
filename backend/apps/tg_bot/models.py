from django.db import models

from apps.common.models import TimestampedModel


class BotSubscription(TimestampedModel):
    """
    A Telegram chat that wants to receive the daily sales report.
    `chat_id` is unique — re-subscribing reactivates instead of duplicating.
    """

    chat_id = models.BigIntegerField(unique=True)
    chat_title = models.CharField(max_length=128, blank=True, default="")
    is_active = models.BooleanField(default=True)

    class Meta:
        ordering = ["-created_at"]

    def __str__(self) -> str:
        return f"chat#{self.chat_id} {self.chat_title}"

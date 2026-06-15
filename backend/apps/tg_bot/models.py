from django.db import models

from apps.common.models import TimestampedModel


class BotSubscription(TimestampedModel):
    """
    Per-chat bot state.
    - `is_active` — opted into the daily sales report (toggled by /subscribe).
    - `language` — UI language for this chat (`ru` or `uz`).

    A row is created on the first interaction with `is_active=False` so we
    can remember the user's language even before they subscribe.
    """

    LANGUAGE_CHOICES = [("ru", "Русский"), ("uz", "Oʻzbekcha")]

    chat_id = models.BigIntegerField(unique=True)
    chat_title = models.CharField(max_length=128, blank=True, default="")
    is_active = models.BooleanField(default=False)
    language = models.CharField(max_length=4, choices=LANGUAGE_CHOICES, default="ru")

    class Meta:
        ordering = ["-created_at"]

    def __str__(self) -> str:
        return f"chat#{self.chat_id} {self.chat_title} ({self.language})"

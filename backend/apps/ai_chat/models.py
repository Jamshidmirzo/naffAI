"""
AI-chat models.

- ``ChatSession`` — a conversation belonging to a single user (manager).
- ``ChatMessage`` — one message in that conversation. Roles: user,
  assistant, tool. ``tool_calls`` stores the structured tool invocations
  the assistant issued in a turn (empty list otherwise).
"""

from __future__ import annotations

from django.conf import settings
from django.db import models

from apps.common.models import TimestampedModel


class ChatSession(TimestampedModel):
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="chat_sessions",
    )
    title = models.CharField(max_length=200, blank=True, default="")

    class Meta:
        ordering = ["-updated_at"]

    def __str__(self) -> str:
        return self.title or f"session#{self.pk}"


class ChatMessage(TimestampedModel):
    ROLE_USER = "user"
    ROLE_ASSISTANT = "assistant"
    ROLE_TOOL = "tool"
    ROLE_CHOICES = [
        (ROLE_USER, "User"),
        (ROLE_ASSISTANT, "Assistant"),
        (ROLE_TOOL, "Tool"),
    ]

    session = models.ForeignKey(
        ChatSession, on_delete=models.CASCADE, related_name="messages"
    )
    role = models.CharField(max_length=16, choices=ROLE_CHOICES)
    content = models.TextField(blank=True, default="")
    tool_calls = models.JSONField(default=list, blank=True)
    tool_name = models.CharField(max_length=64, blank=True, default="")
    model_used = models.CharField(max_length=100, blank=True, default="")
    provider_used = models.CharField(max_length=32, blank=True, default="")

    class Meta:
        ordering = ["created_at"]
        indexes = [models.Index(fields=["session", "created_at"])]

    def __str__(self) -> str:
        return f"{self.role}: {self.content[:40]}"

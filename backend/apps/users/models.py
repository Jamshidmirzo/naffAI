"""
We keep Django's default `User` and attach a `Profile` with a role.

Roles drive permission classes in `permissions.py`.
"""

from __future__ import annotations

from django.conf import settings
from django.db import models


class Role(models.TextChoices):
    TEAM_LEAD = "team_lead", "Тимлид"
    MANAGER = "manager", "Менеджер"
    OPERATOR = "operator", "Оператор"


class Profile(models.Model):
    user = models.OneToOneField(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="profile",
    )
    role = models.CharField(max_length=16, choices=Role.choices, default=Role.TEAM_LEAD)
    operator = models.ForeignKey(
        "operators.Operator",
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="user_profiles",
        help_text="Linked when this user logs in as a specific operator.",
    )
    telegram_user_id = models.BigIntegerField(
        null=True,
        blank=True,
        unique=True,
        help_text=(
            "Populated by the bot's /link_operator FSM once the user "
            "confirms their operator phone. Used to DM callback reminders."
        ),
    )

    def __str__(self) -> str:
        return f"{self.user.username} ({self.get_role_display()})"

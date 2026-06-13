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

    def __str__(self) -> str:
        return f"{self.user.username} ({self.get_role_display()})"

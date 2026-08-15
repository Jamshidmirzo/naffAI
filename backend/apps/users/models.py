"""
We keep Django's default `User` and attach a `Profile` with a role.

Roles drive permission classes in `permissions.py`.

`OperatorSecret` stores a reversibly-encrypted copy of the plaintext
password so a manager can look it up later (business requirement — team
lead needs to hand out credentials without forcing a reset every time).
The Django hash still lives in `User.password`; both are updated in
lock-step via `apps.users.services.user_password_set`.
"""

from __future__ import annotations

from django.conf import settings
from django.db import models


class Role(models.TextChoices):
    TEAM_LEAD = "team_lead", "Тимлид"
    MANAGER = "manager", "Менеджер"
    OPERATOR = "operator", "Оператор"
    # Внутренняя роль «супер-админ» — расширенный менеджер: имеет
    # ВСЕ права manager/team_lead + доступ к галерее фото
    # attendance по всем операторам. В UI отображается как менеджер
    # (normaliseRole → "manager"), навигация та же, единственное
    # отличие — пункт «Фото сотрудников» под IsSuperadminOrManager.
    SUPERADMIN = "superadmin", "Супер-админ"


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
    # One-time 6-digit code the user pastes to @naffai_bot with `/link CODE`
    # to bind their Telegram chat to this profile. Cleared on successful
    # bind. Read/written by the /me/telegram/link-code/ endpoint and the
    # bot's cmd_link handler.
    tg_link_code = models.CharField(max_length=8, blank=True, default="", db_index=True)
    tg_link_code_expires_at = models.DateTimeField(null=True, blank=True)
    deleted_at = models.DateTimeField(
        null=True,
        blank=True,
        help_text="Soft-delete marker for operator accounts (set together with User.is_active=False).",
    )
    # 2026-08-15: attendance section PIN-gate. Manager вводит 4-значный PIN
    # при входе в attendance-раздел (фото сотрудников), чтобы другой менеджер
    # на общем компе не увидел чужие фото. Хранится хеш (make_password),
    # сброс — только superadmin. Superadmin PIN не требуется.
    attendance_pin_hash = models.CharField(
        max_length=128,
        blank=True,
        default="",
        help_text="Django password-hash 4-значного PIN'a. Пусто = PIN не задан.",
    )

    def __str__(self) -> str:
        return f"{self.user.username} ({self.get_role_display()})"


class OperatorSecret(models.Model):
    """
    Reversibly-encrypted password store — one row per User.

    We keep the ciphertext (Fernet, key from settings) so a manager can
    view the current password without resetting. The Django hash on
    `User.password` remains the source of truth for auth; this row is a
    convenience surface for the admin UI.
    """

    user = models.OneToOneField(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="secret",
    )
    encrypted_password = models.BinaryField()
    key_version = models.PositiveSmallIntegerField(
        default=1,
        help_text=(
            "Which key from OPERATOR_PASSWORD_ENCRYPTION_KEYS was used to "
            "encrypt this row. Read alongside encrypted_password so we can "
            "rotate the master key without invalidating old rows."
        ),
    )
    updated_at = models.DateTimeField(auto_now=True)

    def __str__(self) -> str:
        return f"secret<{self.user_id}>"

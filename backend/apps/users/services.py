"""
Write-side business logic for user/account lifecycle.

HackSoft: keep views/serializers thin, everything transactional and
auditable lives here.

Password rules baked in:
- Every password write updates BOTH `User.password` (Django hash, source
  of truth for auth) AND `OperatorSecret.encrypted_password` (Fernet
  ciphertext, source of truth for the "view password" admin surface).
- Plaintext never leaks into AuditLog diffs — the audit records the
  actor/target/action, not the password itself.
"""

from __future__ import annotations

from django.contrib.auth import get_user_model
from django.db import transaction
from django.utils import timezone
from rest_framework.exceptions import ValidationError

from apps.audit.services import AuditAction, audit_log_create
from apps.common.validators import normalize_uz_phone
from apps.operators.models import Operator

from .crypto import decrypt_password, encrypt_password
from .models import OperatorSecret, Profile, Role
from .selectors import user_by_operator
from .utils import generate_temp_password

User = get_user_model()

MIN_PASSWORD_LEN = 8


class AccountAction:
    CREATED = "account_created"
    PASSWORD_VIEWED = "password_viewed"
    PASSWORD_RESET = "password_reset"
    PASSWORD_CHANGED_BY_SELF = "password_changed_by_self"
    DEACTIVATED = "account_deactivated"
    ACTIVATED = "account_activated"
    DELETED = "account_deleted"


def _validate_plain(plain: str) -> None:
    if not isinstance(plain, str) or len(plain) < MIN_PASSWORD_LEN:
        raise ValidationError(
            {"password": f"Пароль должен быть не короче {MIN_PASSWORD_LEN} символов"}
        )


def _login_from_operator(operator: Operator) -> str:
    normalized, valid = normalize_uz_phone(operator.phone)
    if not valid:
        raise ValidationError(
            {"phone": "У оператора не указан валидный номер телефона (+998XXXXXXXXX)"}
        )
    return normalized


@transaction.atomic
def user_password_set(*, user: User, plain: str) -> None:
    """
    Atomic: update Django hash AND reversible ciphertext for the user.

    No audit here — this is a primitive; the caller decides which
    business action was actually performed (create / reset / self-change).
    """
    _validate_plain(plain)
    user.set_password(plain)
    user.save(update_fields=["password"])

    cipher, version = encrypt_password(plain)
    OperatorSecret.objects.update_or_create(
        user=user,
        defaults={"encrypted_password": cipher, "key_version": version},
    )


@transaction.atomic
def account_create_for_operator(
    *, operator: Operator, actor: User | None, plain: str | None = None
) -> tuple[User, str]:
    """
    Create a fresh account for this operator.

    Login = normalized phone. Password is either the provided plaintext
    (validated ≥ MIN_PASSWORD_LEN) or a freshly generated `Naff-XXXXXX`.
    Returns `(user, plaintext_used)` — the caller (API) is expected to
    hand the plaintext to the manager once, then never again.
    """
    login = _login_from_operator(operator)

    existing = user_by_operator(operator)
    if existing is not None:
        raise ValidationError({"detail": "У оператора уже есть активный аккаунт"})

    if User.objects.filter(username=login).exists():
        raise ValidationError(
            {"detail": f"Логин {login} уже занят другим пользователем"}
        )

    if plain is None or plain == "":
        plain = generate_temp_password()
    _validate_plain(plain)

    user = User.objects.create(
        username=login,
        is_active=True,
    )
    Profile.objects.create(user=user, role=Role.OPERATOR, operator=operator)
    user_password_set(user=user, plain=plain)

    audit_log_create(
        user=actor,
        action=AuditAction.CREATE,
        entity="users.OperatorAccount",
        entity_id=user.id,
        changes={
            "kind": AccountAction.CREATED,
            "operator_id": operator.id,
            "username": login,
        },
    )
    return user, plain


@transaction.atomic
def account_reset_password(
    *, user: User, actor: User | None, plain: str | None = None
) -> str:
    if plain is None or plain == "":
        plain = generate_temp_password()
    _validate_plain(plain)

    user_password_set(user=user, plain=plain)
    audit_log_create(
        user=actor,
        action=AuditAction.UPDATE,
        entity="users.OperatorAccount",
        entity_id=user.id,
        changes={
            "kind": AccountAction.PASSWORD_RESET,
            "target_user_id": user.id,
        },
    )
    return plain


@transaction.atomic
def account_deactivate(*, user: User, actor: User | None) -> None:
    if not user.is_active:
        return
    user.is_active = False
    user.save(update_fields=["is_active"])
    audit_log_create(
        user=actor,
        action=AuditAction.UPDATE,
        entity="users.OperatorAccount",
        entity_id=user.id,
        changes={
            "kind": AccountAction.DEACTIVATED,
            "target_user_id": user.id,
        },
    )


@transaction.atomic
def account_activate(*, user: User, actor: User | None) -> None:
    if user.is_active:
        return
    user.is_active = True
    user.save(update_fields=["is_active"])
    audit_log_create(
        user=actor,
        action=AuditAction.UPDATE,
        entity="users.OperatorAccount",
        entity_id=user.id,
        changes={
            "kind": AccountAction.ACTIVATED,
            "target_user_id": user.id,
        },
    )


@transaction.atomic
def account_soft_delete(*, user: User, actor: User | None) -> None:
    """
    Soft-delete: block login, wipe the reversible ciphertext, keep the
    Django user + audit history intact so we can still trace who did what.
    """
    user.is_active = False
    user.save(update_fields=["is_active"])

    profile = getattr(user, "profile", None)
    if profile is not None:
        profile.deleted_at = timezone.now()
        profile.save(update_fields=["deleted_at"])

    OperatorSecret.objects.filter(user=user).delete()

    audit_log_create(
        user=actor,
        action=AuditAction.DELETE,
        entity="users.OperatorAccount",
        entity_id=user.id,
        changes={
            "kind": AccountAction.DELETED,
            "target_user_id": user.id,
        },
    )


def password_view(*, actor: User, target_user: User) -> str:
    """
    Decrypt and return the operator's current password. Every view is
    audited — the whole point of the manager surface is that these
    lookups are traceable.
    """
    secret = OperatorSecret.objects.filter(user=target_user).first()
    if secret is None:
        raise ValidationError(
            {"detail": "Пароль недоступен для просмотра — сбросьте его"}
        )
    plain = decrypt_password(secret.encrypted_password, key_version=secret.key_version)
    audit_log_create(
        user=actor,
        action=AuditAction.OVERRIDE,
        entity="users.OperatorAccount",
        entity_id=target_user.id,
        changes={
            "kind": AccountAction.PASSWORD_VIEWED,
            "target_user_id": target_user.id,
        },
    )
    return plain


@transaction.atomic
def self_change_password(*, user: User, old_password: str, new_password: str) -> None:
    if not user.check_password(old_password):
        raise ValidationError({"old_password": "Текущий пароль неверный"})
    _validate_plain(new_password)
    user_password_set(user=user, plain=new_password)
    audit_log_create(
        user=user,
        action=AuditAction.UPDATE,
        entity="users.OperatorAccount",
        entity_id=user.id,
        changes={
            "kind": AccountAction.PASSWORD_CHANGED_BY_SELF,
            "target_user_id": user.id,
        },
    )

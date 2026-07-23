"""
Read-side helpers for the users app. HackSoft: keep views thin, put
queries here so they can be reused between apis and management commands.
"""

from __future__ import annotations

from django.contrib.auth import get_user_model

from apps.operators.models import Operator

from .models import OperatorSecret, Profile

User = get_user_model()


def user_by_operator(operator: Operator) -> User | None:
    """
    Locate the User linked to this operator via `Profile.operator`.

    Deleted profiles (`deleted_at` set) are ignored — a soft-deleted
    account should look as if it doesn't exist for the account-creation
    flow.
    """
    profile = (
        Profile.objects
        .select_related("user")
        .filter(operator=operator, deleted_at__isnull=True)
        .first()
    )
    return profile.user if profile else None


def operator_secret_get(user: User) -> OperatorSecret | None:
    return OperatorSecret.objects.filter(user=user).first()


def account_state(user: User | None) -> dict:
    """
    Compact status snapshot rendered next to each Operator row in the UI.
    """
    if user is None:
        return {"has_account": False, "is_active": False, "deleted": False, "username": None}
    profile = getattr(user, "profile", None)
    return {
        "has_account": True,
        "is_active": bool(user.is_active),
        "deleted": bool(profile and profile.deleted_at is not None),
        "username": user.username,
    }

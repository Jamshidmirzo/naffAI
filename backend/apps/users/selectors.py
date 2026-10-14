"""
Read-side helpers for the users app. HackSoft: keep views thin, put
queries here so they can be reused between apis and management commands.
"""

from __future__ import annotations

from django.contrib.auth import get_user_model
from django.db.models import Q

from apps.operators.models import Operator

from .models import OperatorSecret, Profile, Role

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


def _actor_role(actor) -> str | None:
    """Resolve actor's effective role (or None for anonymous/unauthed)."""
    if not actor or not getattr(actor, "is_authenticated", False):
        return None
    profile = getattr(actor, "profile", None)
    return profile.role if profile else None


def visible_operator_ids(actor) -> list[int]:
    """
    Which `Operator.id`'s should `actor` be able to see?

    Semantics follow the 3-level hierarchy described in Role.SUPER_MANAGER:
      * Django superuser / role=SUPERADMIN  → every operator.
      * role=SUPER_MANAGER → own direct operators (managed_by=self) +
        operators of own managers (managed_by in Profile.reports_to=self,
        role=MANAGER).
      * role=MANAGER / TEAM_LEAD → own direct operators (managed_by=self) +
        legacy «общий пул» (managed_by IS NULL). The IS-NULL fallback keeps
        prod backward-compatible until ownership is manually assigned via
        the UI.
      * role=OPERATOR → only own operator row (profile.operator_id).
      * other / anon → empty.

    Return a materialised list of ids so callers can plug into
    `operator_id__in=` filters without passing live querysets around
    (and without accidental duplicate rows across the Q OR).
    """
    if actor is None or not getattr(actor, "is_authenticated", False):
        return []

    profile = getattr(actor, "profile", None)
    role = profile.role if profile else None

    # Superuser / superadmin → see everything.
    if actor.is_superuser or role == Role.SUPERADMIN:
        return list(Operator.objects.values_list("id", flat=True))

    if role == Role.SUPER_MANAGER:
        # Business rule: super_managers are «shared owners» — все super_managers
        # видят ВСЕХ operator'ов (как superadmin). Отдельные ветки не ведём,
        # операторов делят между собой managers через managed_by.
        return list(Operator.objects.values_list("id", flat=True))

    if role in (Role.MANAGER, Role.TEAM_LEAD):
        # Differentiate NEW manager (in hierarchy, has reports_to) from
        # LEGACY manager (no reports_to). NEW manager: strict scope — only
        # operators explicitly handed to them (managed_by=self). LEGACY
        # manager: fallback to own + unassigned pool, preserves pre-super_manager
        # behavior so existing managers don't suddenly see an empty list.
        if getattr(profile, "reports_to_id", None):
            qs = Operator.objects.filter(managed_by=actor)
        else:
            qs = Operator.objects.filter(
                Q(managed_by=actor) | Q(managed_by__isnull=True)
            )
        return list(qs.values_list("id", flat=True))

    if role == Role.OPERATOR:
        op_id = getattr(profile, "operator_id", None)
        if op_id:
            return [op_id]
        return []

    return []


class InvalidManagerFilter(ValueError):
    """Raised when `?manager_id=` is neither an int nor `none`/`null`."""


def can_filter_by_manager(actor) -> bool:
    """`?manager_id=` branch-filter is a super_manager/superadmin privilege."""
    if actor is None or not getattr(actor, "is_authenticated", False):
        return False
    if actor.is_superuser:
        return True
    return _actor_role(actor) in (Role.SUPER_MANAGER, Role.SUPERADMIN)


def operator_ids_for_manager_filter(actor, raw_manager_id) -> list[int] | None:
    """
    Resolve the optional `?manager_id=<user_id>|none` query param into an
    operator-id allowlist **on top of** `visible_operator_ids(actor)`.

    Returns:
      * `None` — no filter requested (param absent/empty) or the actor is
        not allowed to use it (manager/team_lead/operator: silently
        ignored so the endpoint behaves exactly as before);
      * `list[int]` — visible operators with `managed_by_id=<id>`
        (or `managed_by IS NULL` for `none` / `null`).

    Raises `InvalidManagerFilter` for garbage values (callers map → 400).
    """
    if raw_manager_id is None:
        return None
    raw = str(raw_manager_id).strip().lower()
    if raw == "" or not can_filter_by_manager(actor):
        return None
    qs = Operator.objects.filter(id__in=visible_operator_ids(actor))
    if raw in ("none", "null", "unassigned"):
        qs = qs.filter(managed_by__isnull=True)
    else:
        try:
            manager_id = int(raw)
        except (TypeError, ValueError) as exc:
            raise InvalidManagerFilter(raw_manager_id) from exc
        qs = qs.filter(managed_by_id=manager_id)
    return list(qs.values_list("id", flat=True))


def visible_manager_user_ids(actor) -> list[int]:
    """
    Which User-ids should `actor` be able to see on the «Users / Managers»
    admin surface?

    * Superuser / role=SUPERADMIN → all users.
    * role=SUPER_MANAGER → own managers (Profile.reports_to=self,
      role=MANAGER) + self.
    * role=MANAGER / TEAM_LEAD → self only (manager-level users only see
      themselves on /users for Phase 1; the surface is primarily for
      super_manager assignment).
    * else → empty.
    """
    if actor is None or not getattr(actor, "is_authenticated", False):
        return []

    profile = getattr(actor, "profile", None)
    role = profile.role if profile else None

    if actor.is_superuser or role == Role.SUPERADMIN:
        return list(User.objects.values_list("id", flat=True))

    if role == Role.SUPER_MANAGER:
        # Super_managers — shared senior tier. Видят ВСЕХ юзеров системы
        # (как superadmin), чтобы один super_manager мог управлять любым
        # manager'ом независимо от reports_to.
        return list(User.objects.values_list("id", flat=True))

    if role in (Role.MANAGER, Role.TEAM_LEAD):
        return [actor.id]

    return []


def account_state(user: User | None) -> dict:
    """
    Compact status snapshot rendered next to each Operator row in the UI.
    """
    if user is None:
        return {
            "has_account": False,
            "is_active": False,
            "deleted": False,
            "username": None,
            "preferred_language": None,
        }
    profile = getattr(user, "profile", None)
    return {
        "has_account": True,
        "is_active": bool(user.is_active),
        "deleted": bool(profile and profile.deleted_at is not None),
        "username": user.username,
        "preferred_language": getattr(profile, "preferred_language", None) or "uz",
    }

from rest_framework.permissions import BasePermission

from .models import Role


def _role(user) -> str | None:
    if not user or not user.is_authenticated:
        return None
    if user.is_superuser:
        return Role.TEAM_LEAD
    profile = getattr(user, "profile", None)
    return profile.role if profile else None


class IsTeamLead(BasePermission):
    def has_permission(self, request, view) -> bool:
        return _role(request.user) == Role.TEAM_LEAD


class IsTeamLeadOrManagerReadOnly(BasePermission):
    """Managers can read, only the team lead can write."""

    def has_permission(self, request, view) -> bool:
        role = _role(request.user)
        if role == Role.TEAM_LEAD:
            return True
        if role == Role.MANAGER and request.method in ("GET", "HEAD", "OPTIONS"):
            return True
        return False


class IsOperator(BasePermission):
    """
    Grants access if the user is logged in as a call-center operator (i.e.
    Profile.role == 'operator' and Profile.operator FK is set). Team leads
    also pass — they can act on behalf of any operator from the admin UI.
    """

    def has_permission(self, request, view) -> bool:
        role = _role(request.user)
        if role == Role.TEAM_LEAD:
            return True
        if role != Role.OPERATOR:
            return False
        profile = getattr(request.user, "profile", None)
        return bool(profile and profile.operator_id)


class IsAuthenticatedAnyRole(BasePermission):
    """Anyone with a valid role (team_lead / manager / operator) may proceed."""

    def has_permission(self, request, view) -> bool:
        return _role(request.user) in {Role.TEAM_LEAD, Role.MANAGER, Role.OPERATOR}


class IsManager(BasePermission):
    """
    Manager-only surface: operator account CRUD (create login, view /
    reset password, block, delete).

    Note: superusers pass via _role() → TEAM_LEAD, which is intentionally
    NOT granted here — the account-management endpoints are restricted to
    the dedicated 'manager' role per business decision. Superuser access
    is only granted explicitly below so ops can recover a lockout.
    """

    def has_permission(self, request, view) -> bool:
        if request.user and request.user.is_superuser:
            return True
        return _role(request.user) == Role.MANAGER

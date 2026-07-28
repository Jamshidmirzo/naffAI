from rest_framework.permissions import BasePermission

from .models import Role

# Business rule: the UI only exposes two roles — `manager` and `operator`.
# In the DB we still carry a third internal role, `team_lead`, but it is
# treated as equivalent to `manager` for permissions (both are "senior"
# with full write access). All senior-level permission classes below
# therefore accept either.
SENIOR_ROLES = {Role.TEAM_LEAD, Role.MANAGER}


def _role(user) -> str | None:
    if not user or not user.is_authenticated:
        return None
    if user.is_superuser:
        return Role.TEAM_LEAD
    profile = getattr(user, "profile", None)
    return profile.role if profile else None


def _is_senior(user) -> bool:
    return _role(user) in SENIOR_ROLES


class IsTeamLead(BasePermission):
    def has_permission(self, request, view) -> bool:
        return _is_senior(request.user)


class IsTeamLeadOrManagerReadOnly(BasePermission):
    """
    Kept for backward compatibility with existing view configs.
    Under the new role model both senior roles have full write access.
    """

    def has_permission(self, request, view) -> bool:
        return _is_senior(request.user)


class IsOperator(BasePermission):
    """
    Grants access if the user is logged in as a call-center operator (i.e.
    Profile.role == 'operator' and Profile.operator FK is set). Senior
    users (team_lead / manager) also pass — they can act on behalf of any
    operator from the admin UI.
    """

    def has_permission(self, request, view) -> bool:
        if _is_senior(request.user):
            return True
        if _role(request.user) != Role.OPERATOR:
            return False
        profile = getattr(request.user, "profile", None)
        return bool(profile and profile.operator_id)


class IsAuthenticatedAnyRole(BasePermission):
    """Anyone with a valid role (team_lead / manager / operator) may proceed."""

    def has_permission(self, request, view) -> bool:
        return _role(request.user) in {Role.TEAM_LEAD, Role.MANAGER, Role.OPERATOR}


class IsManager(BasePermission):
    """
    Account-CRUD surface (create login, reset password, block, delete).
    Both senior roles + superuser pass.
    """

    def has_permission(self, request, view) -> bool:
        if request.user and request.user.is_superuser:
            return True
        return _is_senior(request.user)

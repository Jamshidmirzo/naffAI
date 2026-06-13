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

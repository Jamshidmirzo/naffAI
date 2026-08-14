from rest_framework.permissions import BasePermission

from apps.users.models import Role


def _role(user) -> str | None:
    if not user or not user.is_authenticated:
        return None
    if user.is_superuser:
        return Role.TEAM_LEAD
    profile = getattr(user, "profile", None)
    return profile.role if profile else None


class IsSessionOwnerOrManager(BasePermission):
    """
    Operator can manage only their own TG session.
    Manager / team_lead can view any session status.
    """

    def has_permission(self, request, view) -> bool:
        role = _role(request.user)
        if role in (Role.TEAM_LEAD, Role.MANAGER, Role.SUPERADMIN):
            return True
        if role == Role.OPERATOR:
            profile = getattr(request.user, "profile", None)
            return bool(profile and profile.operator_id)
        return False


class IsManagerOrTeamLead(BasePermission):
    """Manager-only read endpoints for chats/messages/insights."""

    def has_permission(self, request, view) -> bool:
        return _role(request.user) in (Role.TEAM_LEAD, Role.MANAGER, Role.SUPERADMIN)

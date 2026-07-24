from rest_framework.permissions import BasePermission
from apps.users.models import Role


def _role(user) -> str | None:
    if not user or not user.is_authenticated:
        return None
    if user.is_superuser:
        return Role.TEAM_LEAD
    profile = getattr(user, "profile", None)
    return profile.role if profile else None


class IsOwnerOrManager(BasePermission):
    """Grants access if:

    - User is team_lead / manager.
    - User is operator and owns the requested lesson.
    """

    def has_permission(self, request, view) -> bool:
        role = _role(request.user)
        return role in (Role.TEAM_LEAD, Role.MANAGER, Role.OPERATOR)

    def has_object_permission(self, request, view, obj) -> bool:
        role = _role(request.user)
        if role in (Role.TEAM_LEAD, Role.MANAGER):
            return True
        profile = getattr(request.user, "profile", None)
        return bool(profile and profile.operator_id == obj.operator_id)

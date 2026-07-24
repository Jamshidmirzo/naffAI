from rest_framework.permissions import BasePermission
from apps.users.permissions import _role
from apps.users.models import Role


class IsTeamLeadOrManager(BasePermission):
    def has_permission(self, request, view) -> bool:
        role = _role(request.user)
        return role in (Role.TEAM_LEAD, Role.MANAGER)

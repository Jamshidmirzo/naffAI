from rest_framework.permissions import BasePermission
from apps.users.permissions import _role, SENIOR_ROLES


class IsTeamLeadOrManager(BasePermission):
    def has_permission(self, request, view) -> bool:
        # SENIOR_ROLES = {team_lead, manager, superadmin} — superadmin
        # автоматически получает доступ ко всем attendance endpoint'ам.
        return _role(request.user) in SENIOR_ROLES

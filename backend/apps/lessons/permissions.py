from rest_framework.permissions import BasePermission
from apps.users.models import Role


def _role(user) -> str | None:
    if not user or not user.is_authenticated:
        return None
    if user.is_superuser:
        return Role.TEAM_LEAD
    profile = getattr(user, "profile", None)
    return profile.role if profile else None


MANAGER_ROLES = (Role.TEAM_LEAD, Role.MANAGER, Role.SUPERADMIN)


def is_manager_role(role: str | None) -> bool:
    """Все senior-роли (team_lead / manager / superadmin) имеют одинаковые
    права на чтение чужих уроков. Продукт объединяет их в UI как «менеджер»,
    и API должно следовать той же семантике — иначе superadmin получит 400
    на любую операцию, требующую manager-права.
    """
    return role in MANAGER_ROLES


class IsOwnerOrManager(BasePermission):
    """Grants access if:

    - User is team_lead / manager / superadmin.
    - User is operator and owns the requested lesson.
    """

    def has_permission(self, request, view) -> bool:
        role = _role(request.user)
        return role in (*MANAGER_ROLES, Role.OPERATOR)

    def has_object_permission(self, request, view, obj) -> bool:
        role = _role(request.user)
        if is_manager_role(role):
            return True
        profile = getattr(request.user, "profile", None)
        return bool(profile and profile.operator_id == obj.operator_id)

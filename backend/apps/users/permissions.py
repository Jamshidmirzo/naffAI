from rest_framework.permissions import BasePermission

from .models import Role

# Business rule: the UI only exposes two roles — `manager` and `operator`.
# In the DB we carry a few internal roles that all collapse to "senior":
#   - `team_lead`  — исторический senior-роль (в UI показывается как менеджер)
#   - `manager`    — обычный senior
#   - `superadmin` — расширенный senior + доступ к галерее attendance-фото
# Все senior-роли ниже трактуются одинаково для permission-classes;
# `superadmin` — надмножество manager (+ фото-галерея).
SENIOR_ROLES = {Role.TEAM_LEAD, Role.MANAGER, Role.SUPERADMIN}
MANAGER_LEVEL_ROLES = SENIOR_ROLES  # публичный alias для внешних мест


def _role(user) -> str | None:
    if not user or not user.is_authenticated:
        return None
    if user.is_superuser:
        return Role.TEAM_LEAD
    profile = getattr(user, "profile", None)
    return profile.role if profile else None


def _is_senior(user) -> bool:
    return _role(user) in SENIOR_ROLES


def is_manager_or_above(role: str | None) -> bool:
    """
    Хелпер для мест, которые фильтруют по `role in (...)` без permission
    class'a (сервисы, management-команды, тесты). Возвращает True для
    team_lead / manager / superadmin.
    """
    return role in SENIOR_ROLES


def _is_superadmin(user) -> bool:
    """True только для роли `superadmin` — привилегия галереи фото."""
    return _role(user) == Role.SUPERADMIN


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


class IsSuperadminOrManager(BasePermission):
    """
    Access permitted for senior roles (team_lead / manager / superadmin)
    и Django superuser. Используется для attendance-фото-галереи и
    других расширенных read-endpoint'ов, которые открыты всем менеджерам.
    (На практике — эквивалент IsManager: и team_lead, и manager, и
    superadmin все считаются "senior".)
    """

    def has_permission(self, request, view) -> bool:
        if request.user and request.user.is_superuser:
            return True
        return _is_senior(request.user)


class IsSuperadmin(BasePermission):
    """Ужe жёсткая проверка на роль superadmin — не используется по
    умолчанию (галерея открыта всем менеджерам), оставлено для
    точечных superadmin-only endpoint'ов в будущем."""

    def has_permission(self, request, view) -> bool:
        if request.user and request.user.is_superuser:
            return True
        return _is_superadmin(request.user)

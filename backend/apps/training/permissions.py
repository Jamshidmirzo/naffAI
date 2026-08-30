"""
Permission classes for the ``training`` app.

Manager endpoints — `IsManager` (переиспользуем существующий из
`apps.users.permissions`). Operator endpoints — `IsAuthenticated`, но
внутри вьюхи проверяем, что у profile есть привязка к operator.
"""

from __future__ import annotations

from rest_framework.permissions import BasePermission

from apps.users.models import Role
from apps.users.permissions import IsManager, _is_senior, _role  # noqa: F401 — re-export


class IsOperatorWithProfile(BasePermission):
    """
    Оператор — с привязкой к `Profile.operator`. Senior-роли также
    проходят (они могут пройти обучение "от лица" оператора, если
    у них есть привязка; иначе получат 400 на attempt/comment
    endpoint'ах — там нужен operator_id).
    """

    def has_permission(self, request, view) -> bool:
        user = request.user
        if not user or not user.is_authenticated:
            return False
        # Superuser (root) — пусть проходит permission, но реально
        # ничего сделать не сможет без operator_id (это отдельная 400).
        if user.is_superuser:
            return True
        if _is_senior(user):
            return True
        if _role(user) != Role.OPERATOR:
            return False
        profile = getattr(user, "profile", None)
        return bool(profile and profile.operator_id)

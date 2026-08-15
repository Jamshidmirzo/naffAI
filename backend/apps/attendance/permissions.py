from rest_framework import status as drf_status
from rest_framework.exceptions import APIException
from rest_framework.permissions import BasePermission

from apps.users.models import Role
from apps.users.permissions import _role, SENIOR_ROLES

from .pin_services import attendance_pin_session_is_valid


class IsTeamLeadOrManager(BasePermission):
    def has_permission(self, request, view) -> bool:
        # SENIOR_ROLES = {team_lead, manager, superadmin} — superadmin
        # автоматически получает доступ ко всем attendance endpoint'ам.
        return _role(request.user) in SENIOR_ROLES


class PinRequired(APIException):
    """
    Специальный 401 с кодом `pin_required` — фронт перехватит по коду и
    покажет PIN-модалку без разлогина.

    Не наследуем NotAuthenticated, потому что DRF по умолчанию
    downgrade-ит его до 403 если у auth-класса нет `authenticate_header`
    (у TokenAuthentication его нет). Делаем свой APIException с явным
    status_code=401.
    """

    status_code = drf_status.HTTP_401_UNAUTHORIZED
    default_detail = "PIN подтверждение обязательно для этой секции"
    default_code = "pin_required"


class IsAttendancePinVerified(BasePermission):
    """
    Пропускает superadmin без проверки PIN'a; для остальных senior-ролей
    требует свежую (< 30 минут) `AttendancePinSession`. Всё, что не
    senior (операторы, анон), сюда не доходит — фильтрует
    `IsTeamLeadOrManager` до неё.

    Комбинируется в `permission_classes` ПОСЛЕ `IsAuthenticated`
    и `IsTeamLeadOrManager` — тогда для operator'a возвращается 403, а
    для менеджера без PIN — наш кастомный 401 pin_required.
    """

    def has_permission(self, request, view) -> bool:
        user = request.user
        if not user or not user.is_authenticated:
            # DRF отдаст стандартный 401 через IsAuthenticated раньше нас,
            # но подстрахуемся.
            return False
        if _role(user) == Role.SUPERADMIN:
            return True
        if attendance_pin_session_is_valid(user):
            return True
        # Отличаем «не тот роль» (пусть отвечает IsTeamLeadOrManager 403)
        # от «нужен PIN» — свой exception с кодом.
        # `detail`-объект остаётся под ключом «detail», а «code» кладём в
        # верхний уровень тела ответа, чтобы фронтовый interceptor мог
        # проверить `body.code === 'pin_required'` без разбора текста.
        raise PinRequired({
            "detail": "PIN подтверждение обязательно для этой секции",
            "code": "pin_required",
        })

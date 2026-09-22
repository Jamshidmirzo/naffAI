"""
Custom DRF permissions for the operators app.

`IsDestructiveActionPinVerified` gates destructive actions (currently:
operator deactivate) behind the SAME global attendance PIN that
`IsAttendancePinVerified` uses, but with one key difference — it does
NOT bypass superadmin. Even the top account has to type the PIN before
knocking operators offline, matching the manager-team_lead flow.

Reusing the attendance PIN keeps the mental model simple: one 4-digit
combination unlocks every senior-only privileged action for 30 minutes.
"""

from rest_framework.permissions import BasePermission

from apps.attendance.permissions import PinRequired
from apps.attendance.pin_services import attendance_pin_session_is_valid
from apps.users.permissions import _role, SENIOR_ROLES


class IsDestructiveActionPinVerified(BasePermission):
    def has_permission(self, request, view) -> bool:
        user = request.user
        if not user or not user.is_authenticated:
            return False
        # Non-senior roles are already 403'd by role gates on the view.
        # Guard here as a safety net so we don't accidentally raise a
        # confusing pin_required 401 for a plain operator.
        if _role(user) not in SENIOR_ROLES:
            return False
        if attendance_pin_session_is_valid(user):
            return True
        raise PinRequired({
            "detail": (
                "PIN подтверждение обязательно для деактивации оператора."
            ),
            "code": "pin_required",
        })

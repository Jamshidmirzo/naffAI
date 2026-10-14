"""
Who may receive leads automatically right now.

One rule for every automatic path (round-robin, refill, morning split,
qimmatlik retry, sheet alias/default operator, pools on deactivation):

* status ACTIVE and not paused;
* on shift: an open AttendanceLog checked in today (Tashkent date) —
  required when the daily check-in is enforced globally
  (``AttendanceSettings.enforce_daily_checkin``) or for this operator
  (``Operator.require_checkin_enabled``), the same rule the UI gate uses.

``settings.LEADS_REQUIRE_OPEN_SHIFT=False`` switches the shift part off
(emergency switch; also the default in tests).

Manual assignment by a manager is never blocked by this module — callers
may use :func:`operator_unavailable_reason` to warn instead.
"""

from __future__ import annotations

import logging

from django.conf import settings
from django.db.models import Exists, OuterRef, Q, QuerySet
from django.utils import timezone

from apps.operators.models import Operator, OperatorStatus

logger = logging.getLogger(__name__)


def _shift_required_globally() -> bool | None:
    """True/False from AttendanceSettings; None when the shift rule is switched off."""
    if not getattr(settings, "LEADS_REQUIRE_OPEN_SHIFT", True):
        return None
    try:
        from apps.attendance.selectors import attendance_settings_get

        return bool(attendance_settings_get().enforce_daily_checkin)
    except Exception:  # pragma: no cover - settings row unreadable
        logger.warning("availability: attendance settings unreadable, enforcing shift rule", exc_info=True)
        return True


def _open_shift_today():
    from apps.attendance.models import AttendanceLog

    return AttendanceLog.objects.filter(
        operator=OuterRef("pk"),
        checked_in_at__date=timezone.localdate(),
        checked_out_at__isnull=True,
    )


def operators_available_for_auto_leads(qs: QuerySet[Operator] | None = None) -> QuerySet[Operator]:
    """Narrow ``qs`` (default: all operators) to those who may get leads automatically now."""
    qs = (qs if qs is not None else Operator.objects.all()).filter(status=OperatorStatus.ACTIVE, is_paused=False)
    required = _shift_required_globally()
    if required is None:
        return qs
    on_shift = Exists(_open_shift_today())
    if required:
        return qs.filter(on_shift)
    return qs.filter(Q(require_checkin_enabled=False) | on_shift)


def operator_unavailable_reason(operator: Operator | None) -> str | None:
    """None when the operator may get leads automatically, else a short machine reason."""
    if operator is None:
        return "no_operator"
    if operator.status != OperatorStatus.ACTIVE:
        return "inactive"
    if operator.is_paused:
        return "paused"
    required = _shift_required_globally()
    if required is None:
        return None
    if not required and not operator.require_checkin_enabled:
        return None
    from apps.attendance.models import AttendanceLog

    on_shift = AttendanceLog.objects.filter(
        operator_id=operator.pk,
        checked_in_at__date=timezone.localdate(),
        checked_out_at__isnull=True,
    ).exists()
    return None if on_shift else "not_on_shift"


def shift_required_for(operator: Operator) -> bool:
    """Is this operator expected to check in before getting leads?"""
    required = _shift_required_globally()
    if required is None:
        return False
    return bool(required or operator.require_checkin_enabled)


def operator_is_available(operator: Operator | None) -> bool:
    return operator_unavailable_reason(operator) is None

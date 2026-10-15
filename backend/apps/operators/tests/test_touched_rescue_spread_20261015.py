"""
2026-10-15: touched leads of a deactivated operator go to «those who work»,
split evenly.

Prod: zarina was deactivated at 11:13 while only two operators had checked
in; the pool was «on shift right now» and the pick was «least loaded», so all
217 touched leads went to Tilla. Now the pool is every active operator who
had a shift in the last days and is not on a manager's manual pause (the
end-of-shift pause does not count), and the split is even.
"""

from __future__ import annotations

import datetime as dt

import pytest
from django.utils import timezone

from apps.attendance.models import AttendanceLog
from apps.calls.models import CallbackReminder, CallbackReminderStatus
from apps.leads.models import Lead, LeadAssignment, LeadAssignmentSource, LeadStatus
from apps.operators.models import Operator, OperatorStatus
from apps.operators.services import (
    operator_deactivate,
    operators_for_touched_rescue,
    spread_touched_leads,
)

pytestmark = pytest.mark.django_db


def _op(name: str, *, worked_days_ago: int | None = 1, **kw) -> Operator:
    op = Operator.objects.create(full_name=name, status=kw.pop("status", OperatorStatus.ACTIVE), **kw)
    if worked_days_ago is not None:
        at = timezone.now() - dt.timedelta(days=worked_days_ago)
        AttendanceLog.objects.create(operator=op, checked_in_at=at, checked_out_at=at + dt.timedelta(hours=8))
    return op


_n = iter(range(1, 100_000))


def _touched(op: Operator, status: str = LeadStatus.NO_ANSWER) -> Lead:
    i = next(_n)
    lead = Lead.objects.create(full_name=f"T-{i}", phone=f"+99893{i:07d}", status=status, operator=op)
    LeadAssignment.objects.create(lead=lead, operator=op, source=LeadAssignmentSource.ADMIN_REASSIGN, active=True)
    return lead


def test_pool_is_those_who_work():
    worked_paused_at_checkout = _op("Raximjon", is_paused=True, paused_reason="auto_close")
    worked_legacy_pause = _op("Vasila", is_paused=True, paused_reason="")
    working_now = _op("Tilla", worked_days_ago=0)
    _op("Xasan", worked_days_ago=None)  # active, not paused, never comes
    _op("Old", worked_days_ago=20)
    _op("Manual", is_paused=True, paused_reason="manual")
    _op("Gone", status=OperatorStatus.INACTIVE)

    pool = {o.full_name for o in operators_for_touched_rescue()}

    assert pool == {worked_paused_at_checkout.full_name, worked_legacy_pause.full_name, working_now.full_name}


def test_pool_falls_back_to_not_paused_when_nobody_worked_recently():
    free = _op("Free", worked_days_ago=None)
    _op("Paused", worked_days_ago=None, is_paused=True)
    assert operators_for_touched_rescue() == [free]


def test_deactivation_splits_touched_leads_evenly():
    leaving = _op("Leaving")
    a, b, c = _op("A"), _op("B"), _op("C")
    for _ in range(40):  # A is the least loaded by far — must not get everything
        _touched(b)
        _touched(c)
    leads = [_touched(leaving) for _ in range(9)]

    operator_deactivate(operator=leaving, user=None)

    got = {a.id: 0, b.id: 0, c.id: 0}
    for lead in leads:
        lead.refresh_from_db()
        got[lead.operator_id] += 1
        assert lead.status == LeadStatus.NO_ANSWER
    assert got == {a.id: 3, b.id: 3, c.id: 3}


def test_spread_keeps_the_holders_share_and_moves_callbacks():
    zarina = _op("zarina", worked_days_ago=None, status=OperatorStatus.INACTIVE)
    tilla, munisa, raxim = _op("Tilla", worked_days_ago=0), _op("Munisa2", worked_days_ago=0), _op("Raximjon")
    leads = [_touched(tilla) for _ in range(9)]
    for lead in leads:
        CallbackReminder.objects.create(
            lead=lead, operator=tilla, remind_at=timezone.now() + dt.timedelta(hours=1), status=CallbackReminderStatus.PENDING
        )

    per_op, cb_moved = spread_touched_leads(leads=leads, pool=[tilla, munisa, raxim], from_operator=zarina)

    owners = {}
    for lead in leads:
        lead.refresh_from_db()
        owners[lead.operator_id] = owners.get(lead.operator_id, 0) + 1
    assert owners == {tilla.id: 3, munisa.id: 3, raxim.id: 3}
    assert per_op == {munisa.id: 3, raxim.id: 3}
    assert cb_moved == 6
    for cb in CallbackReminder.objects.filter(lead__in=leads):
        assert cb.operator_id == cb.lead.operator_id
    moved = [le for le in leads if le.operator_id != tilla.id]
    assert all(le.assignments.get(active=True).source == LeadAssignmentSource.AUTO_RESCUE_TOUCHED for le in moved)
    assert all(le.metadata["rescued_from_operator_name"] == "zarina" for le in moved)

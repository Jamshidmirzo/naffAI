"""
Continuous refill: держим у оператора working_count == RR_BATCH_SIZE.

Заменяет старую логику «refill только когда working == 0». Теперь при
каждом terminal-close считаем `need = target - working` и доливаем
`need` лидов (обычно 1). Если оператор весь день закрывал по одному —
пачка постоянно 5.

RR_BATCH_SIZE = 5 (default в settings).
"""

from __future__ import annotations

import pytest

from apps.leads.models import Lead, LeadAssignment, LeadAssignmentSource, LeadStatus
from apps.leads.services import lead_update_status
from apps.operators.models import Operator, OperatorStatus


def _mk_orphan(idx: int) -> Lead:
    return Lead.objects.create(
        full_name=f"P-{idx}",
        phone=f"+99890{idx:07d}",
        status=LeadStatus.NEW,
        operator=None,
    )


def _mk_assigned(op: Operator, idx: int) -> Lead:
    return Lead.objects.create(
        full_name=f"A-{idx}",
        phone=f"+99899{idx:07d}",
        status=LeadStatus.ASSIGNED,
        operator=op,
    )


@pytest.mark.django_db(transaction=True, serialized_rollback=True)
def test_refill_partial_when_working_below_target():
    """
    Оператор с working=3 (3 assigned). Закрывает 1 → working=2 → need=3.
    В пуле 20 сирот → доливает 3 → working=5.

    Итог по БД: 3 старых - 1 закрытых + 3 refill = 5 активных assigned
    + 1 WON = 6 total.
    """
    op = Operator.objects.create(full_name="OP", status=OperatorStatus.ACTIVE)
    l1 = _mk_assigned(op, 1)
    _mk_assigned(op, 2)
    _mk_assigned(op, 3)

    for i in range(20):
        _mk_orphan(i)

    lead_update_status(lead=l1, status=LeadStatus.WON)

    active = Lead.objects.filter(operator=op).exclude(status=LeadStatus.WON)
    assert active.count() == 5
    assert (
        LeadAssignment.objects.filter(
            operator=op, source=LeadAssignmentSource.AUTO_REFILL
        ).count()
        == 3
    )


@pytest.mark.django_db(transaction=True, serialized_rollback=True)
def test_refill_full_batch_when_operator_empty():
    """
    Оператор с working=1 (последний assigned). Закрывает → working=0 →
    need=5. В пуле 20 сирот → доливает 5 → working=5.
    """
    op = Operator.objects.create(full_name="OP", status=OperatorStatus.ACTIVE)
    only = _mk_assigned(op, 1)
    for i in range(20):
        _mk_orphan(i)

    lead_update_status(lead=only, status=LeadStatus.WON)

    active = Lead.objects.filter(operator=op).exclude(status=LeadStatus.WON)
    assert active.count() == 5
    assert (
        LeadAssignment.objects.filter(
            operator=op, source=LeadAssignmentSource.AUTO_REFILL
        ).count()
        == 5
    )


@pytest.mark.django_db(transaction=True, serialized_rollback=True)
def test_refill_delivers_one_when_working_equals_target_minus_one_after_close():
    """
    Оператор с working=5 (полная пачка). Закрывает 1 → working=4 →
    need=1 → доливает 1 → working=5.
    """
    op = Operator.objects.create(full_name="OP", status=OperatorStatus.ACTIVE)
    leads = [_mk_assigned(op, i) for i in range(5)]
    for i in range(10):
        _mk_orphan(i + 100)

    lead_update_status(lead=leads[0], status=LeadStatus.WON)

    active = Lead.objects.filter(operator=op).exclude(status=LeadStatus.WON)
    assert active.count() == 5
    assert (
        LeadAssignment.objects.filter(
            operator=op, source=LeadAssignmentSource.AUTO_REFILL
        ).count()
        == 1
    )


@pytest.mark.django_db(transaction=True, serialized_rollback=True)
def test_refill_partial_when_pool_smaller_than_need():
    """
    Оператор с working=2. Закрывает 1 → working=1 → need=4. В пуле 2
    сирот → доливает 2 → working=3 (недобор, это ок).
    """
    op = Operator.objects.create(full_name="OP", status=OperatorStatus.ACTIVE)
    l1 = _mk_assigned(op, 1)
    _mk_assigned(op, 2)

    _mk_orphan(101)
    _mk_orphan(102)

    lead_update_status(lead=l1, status=LeadStatus.WON)

    active = Lead.objects.filter(operator=op).exclude(status=LeadStatus.WON)
    assert active.count() == 3
    assert (
        LeadAssignment.objects.filter(
            operator=op, source=LeadAssignmentSource.AUTO_REFILL
        ).count()
        == 2
    )


@pytest.mark.django_db(transaction=True, serialized_rollback=True)
def test_refill_does_not_fire_when_still_at_target_after_close():
    """
    Периферийный кейс: 6 лидов на плечах (over-target), закрыли 1 →
    working=5, need=0 → refill не срабатывает.
    """
    op = Operator.objects.create(full_name="OP", status=OperatorStatus.ACTIVE)
    leads = [_mk_assigned(op, i) for i in range(6)]
    for i in range(10):
        _mk_orphan(i + 200)

    lead_update_status(lead=leads[0], status=LeadStatus.WON)

    assert (
        LeadAssignment.objects.filter(
            operator=op, source=LeadAssignmentSource.AUTO_REFILL
        ).count()
        == 0
    )

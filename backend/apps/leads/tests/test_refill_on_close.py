"""
Refill-по-N: как только у активного оператора счётчик working-лидов
падает до нуля (последний терминализовался в won/lost/…), сервис берёт
следующие N сирот из общего пула и назначает их оператору.
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


def _assign_lead(op: Operator, idx: int, status: str = LeadStatus.ASSIGNED) -> Lead:
    return Lead.objects.create(
        full_name=f"A-{idx}",
        phone=f"+99899{idx:07d}",
        status=status,
        operator=op,
    )


@pytest.mark.django_db(transaction=True, serialized_rollback=True)
def test_refill_fires_when_last_lead_closes():
    """Оператор с 1 активным → закрываем → в пуле 20 сирот → получил 5."""
    op = Operator.objects.create(full_name="OP", status=OperatorStatus.ACTIVE)
    only = _assign_lead(op, 1)

    for i in range(20):
        _mk_orphan(i)

    lead_update_status(lead=only, status=LeadStatus.WON)

    # После on_commit-хука — 5 новых лидов у оператора (плюс уже закрытый won).
    assigned = Lead.objects.filter(operator=op).exclude(status=LeadStatus.WON)
    assert assigned.count() == 5
    assert LeadAssignment.objects.filter(
        operator=op, source=LeadAssignmentSource.AUTO_REFILL
    ).count() == 5


@pytest.mark.django_db(transaction=True, serialized_rollback=True)
def test_refill_does_not_fire_when_other_leads_still_active():
    """Оператор с 2 активными → закрываем 1 → refill НЕ срабатывает."""
    op = Operator.objects.create(full_name="OP", status=OperatorStatus.ACTIVE)
    a = _assign_lead(op, 1)
    _assign_lead(op, 2)  # остаётся активным

    for i in range(20):
        _mk_orphan(i)

    lead_update_status(lead=a, status=LeadStatus.WON)

    # У оператора по-прежнему только 1 активный (второй, что не трогали).
    assert Lead.objects.filter(operator=op, status=LeadStatus.ASSIGNED).count() == 1
    assert LeadAssignment.objects.filter(
        operator=op, source=LeadAssignmentSource.AUTO_REFILL
    ).count() == 0


@pytest.mark.django_db(transaction=True, serialized_rollback=True)
def test_refill_gracefully_handles_empty_pool():
    """Пул пустой — закрытие не падает, оператор остаётся без новых лидов."""
    op = Operator.objects.create(full_name="OP", status=OperatorStatus.ACTIVE)
    only = _assign_lead(op, 1)

    # Никаких сирот.
    lead_update_status(lead=only, status=LeadStatus.WON)

    assert Lead.objects.filter(operator=op).exclude(status=LeadStatus.WON).count() == 0
    assert LeadAssignment.objects.filter(
        source=LeadAssignmentSource.AUTO_REFILL
    ).count() == 0


@pytest.mark.django_db(transaction=True, serialized_rollback=True)
def test_refill_delivers_partial_batch_when_pool_smaller_than_size():
    """В пуле 2 сироты, размер пачки 5 → оператор получит 2."""
    op = Operator.objects.create(full_name="OP", status=OperatorStatus.ACTIVE)
    only = _assign_lead(op, 1)

    _mk_orphan(1)
    _mk_orphan(2)

    lead_update_status(lead=only, status=LeadStatus.WON)

    fresh = Lead.objects.filter(operator=op).exclude(status=LeadStatus.WON)
    assert fresh.count() == 2
    assert LeadAssignment.objects.filter(
        operator=op, source=LeadAssignmentSource.AUTO_REFILL
    ).count() == 2


@pytest.mark.django_db(transaction=True, serialized_rollback=True)
def test_refill_skips_inactive_operator():
    """Оператор INACTIVE → refill не срабатывает даже если пул полный."""
    op = Operator.objects.create(full_name="OP", status=OperatorStatus.ACTIVE)
    only = _assign_lead(op, 1)

    for i in range(10):
        _mk_orphan(i)

    # Деактивируем ДО закрытия — hook сверит статус в момент выполнения.
    op.status = OperatorStatus.INACTIVE
    op.save()

    lead_update_status(lead=only, status=LeadStatus.WON)

    assert Lead.objects.filter(operator=op).exclude(status=LeadStatus.WON).count() == 0
    assert LeadAssignment.objects.filter(
        source=LeadAssignmentSource.AUTO_REFILL
    ).count() == 0

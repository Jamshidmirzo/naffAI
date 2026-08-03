"""
Утренняя раздача (`morning_distribute_leads`): все unassigned активные лиды
делятся поровну round-robin по shuffled(operators). Уже назначенные — не
трогаются. Кривые/needs_review — не участвуют. Идемпотентна.
"""

from __future__ import annotations

import pytest

from apps.leads.models import Lead, LeadAssignment, LeadAssignmentSource, LeadStatus
from apps.leads.services import morning_distribute_leads
from apps.operators.models import Operator, OperatorStatus


def _mk_operator(name: str, status: str = OperatorStatus.ACTIVE) -> Operator:
    return Operator.objects.create(full_name=name, status=status)


def _mk_orphan(
    idx: int,
    *,
    status: str = LeadStatus.NEW,
    phone_invalid: bool = False,
    needs_review: bool = False,
) -> Lead:
    return Lead.objects.create(
        full_name=f"O-{idx}",
        phone=f"+99890{idx:07d}" if not phone_invalid else "",
        phone_invalid=phone_invalid,
        needs_review=needs_review,
        status=status,
        operator=None,
    )


@pytest.mark.django_db
def test_morning_distribute_even_split_12_leads_3_ops():
    ops = [_mk_operator(f"OP-{i}") for i in range(3)]
    for i in range(12):
        _mk_orphan(i)

    counts = morning_distribute_leads(seed=42)

    assert sum(counts.values()) == 12
    # 12 / 3 = 4 каждому.
    for op in ops:
        assert counts[op.id] == 4

    # У каждого назначенного лида — свежая LeadAssignment MORNING_SPLIT.
    assert LeadAssignment.objects.filter(
        source=LeadAssignmentSource.MORNING_SPLIT
    ).count() == 12


@pytest.mark.django_db
def test_morning_distribute_uneven_split_10_leads_3_ops():
    ops = [_mk_operator(f"OP-{i}") for i in range(3)]
    for i in range(10):
        _mk_orphan(i)

    counts = morning_distribute_leads(seed=0)

    # Первые 4/3/3 (детерминированно по seed=0 — но всё равно 10 в сумме
    # и разница между max/min ≤ 1).
    total = sum(counts.values())
    assert total == 10
    values = sorted(counts.values())
    assert values[-1] - values[0] <= 1
    assert set(counts.keys()) == {op.id for op in ops}


@pytest.mark.django_db
def test_morning_distribute_leaves_assigned_leads_alone():
    ops = [_mk_operator(f"OP-{i}") for i in range(2)]
    owner = ops[0]

    # 5 уже назначенных лидов — их оператор не должен смениться.
    already_assigned_ids: list[int] = []
    for i in range(5):
        lead = Lead.objects.create(
            full_name=f"A-{i}",
            phone=f"+99899{i:07d}",
            status=LeadStatus.ASSIGNED,
            operator=owner,
        )
        already_assigned_ids.append(lead.id)

    # 6 сирот, чтобы было что делить.
    for i in range(6):
        _mk_orphan(i)

    counts = morning_distribute_leads(seed=7)

    # Уже назначенные — на том же операторе.
    for lid in already_assigned_ids:
        assert Lead.objects.get(pk=lid).operator_id == owner.id

    # Сироты разошлись.
    assert sum(counts.values()) == 6


@pytest.mark.django_db
def test_morning_distribute_skips_invalid_and_needs_review():
    _mk_operator("OP-0")

    _mk_orphan(1)  # ok
    _mk_orphan(2, phone_invalid=True)
    _mk_orphan(3, needs_review=True)

    counts = morning_distribute_leads(seed=1)

    assert sum(counts.values()) == 1
    assert Lead.objects.filter(operator__isnull=True).count() == 2


@pytest.mark.django_db
def test_morning_distribute_idempotent_second_run_no_op():
    _mk_operator("OP-0")
    for i in range(4):
        _mk_orphan(i)

    first = morning_distribute_leads(seed=1)
    assert sum(first.values()) == 4

    second = morning_distribute_leads(seed=1)
    # Пул пустой — второй запуск возвращает {} (нет unassigned).
    assert second == {}


@pytest.mark.django_db
def test_morning_distribute_dry_run_does_not_mutate():
    for i in range(2):
        _mk_operator(f"OP-{i}")
    for i in range(4):
        _mk_orphan(i)

    counts = morning_distribute_leads(dry_run=True, seed=1)

    assert sum(counts.values()) == 4
    # В БД лиды по-прежнему сироты.
    assert Lead.objects.filter(operator__isnull=True).count() == 4
    assert LeadAssignment.objects.count() == 0


@pytest.mark.django_db
def test_morning_distribute_no_operators_returns_empty():
    for i in range(3):
        _mk_orphan(i)
    assert morning_distribute_leads() == {}
    assert Lead.objects.filter(operator__isnull=True).count() == 3


@pytest.mark.django_db
def test_morning_distribute_ignores_inactive_operators():
    active = _mk_operator("Active")
    _mk_operator("Trainee", status=OperatorStatus.TRAINEE)
    _mk_operator("Inactive", status=OperatorStatus.INACTIVE)
    for i in range(3):
        _mk_orphan(i)

    counts = morning_distribute_leads(seed=1)
    assert counts == {active.id: 3}

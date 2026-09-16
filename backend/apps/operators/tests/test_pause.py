"""
Tests for the «Пауза оператора» flag (2026-09-16, migration 0011).

Семантика паузы:
  * paused=True → оператор НЕ участвует в auto-distribution
    (refill / round-robin / morning-split / rescue-target /
    bulk_reassign round_robin);
  * его собственные лиды **остаются на нём** — никаких rebalanced /
    rescue / system-lost side effects при постановке на паузу.
  * unpause возвращает в общий пул (равен active-до-паузы).
"""

from __future__ import annotations

import pytest

from apps.leads.models import Lead, LeadAssignment, LeadStatus
from apps.leads.services import (
    leads_bulk_reassign,
    morning_distribute_leads,
    refill_operator_leads,
)
from apps.operators.models import Operator, OperatorStatus
from apps.operators.services import operator_deactivate, operator_set_paused


def _mk_op(name: str) -> Operator:
    return Operator.objects.create(full_name=name, status=OperatorStatus.ACTIVE)


def _mk_orphan(idx: int, status: str = LeadStatus.NEW) -> Lead:
    """Сирота: operator=None, свежий."""
    return Lead.objects.create(
        full_name=f"Orphan-{idx}",
        phone=f"+99890{idx:07d}",
        status=status,
        operator=None,
    )


def _mk_lead_on(op: Operator, idx: int, status: str) -> Lead:
    lead = Lead.objects.create(
        full_name=f"L-{op.id}-{idx}",
        phone=f"+99899{op.id:03d}{idx:04d}",
        status=status,
        operator=op,
    )
    LeadAssignment.objects.create(
        lead=lead, operator=op, source="admin_reassign", active=True
    )
    return lead


# ---------------------------------------------------------------------------
# 1. refill_operator_leads: paused-оператор НЕ получает orphaned лидов
# ---------------------------------------------------------------------------

@pytest.mark.django_db
def test_refill_skips_paused_operator():
    """
    Даже если явно вызвать `refill_operator_leads(operator=paused_op)` —
    возвращается пустой список, лидов не назначается. Это ключевой guard,
    т.к. watcher-service и on_commit-хук вызывают refill напрямую для
    конкретного оператора.
    """
    op_a = _mk_op("Alice")
    op_b = _mk_op("Bob")
    op_paused = _mk_op("Paused")
    operator_set_paused(operator=op_paused, paused=True, user=None)

    for i in range(5):
        _mk_orphan(i)

    # Активным раздаётся, paused — нет.
    delivered_a = refill_operator_leads(operator=op_a, size=2)
    delivered_paused = refill_operator_leads(operator=op_paused, size=5)
    delivered_b = refill_operator_leads(operator=op_b, size=2)

    assert len(delivered_a) == 2
    assert delivered_paused == []
    assert len(delivered_b) == 2

    # На paused не должно висеть ни одного нового лида.
    assert Lead.objects.filter(operator=op_paused).count() == 0


# ---------------------------------------------------------------------------
# 2. rescue-target: paused-оператор НЕ становится приёмником touched-лидов
# ---------------------------------------------------------------------------

@pytest.mark.django_db
def test_paused_operator_is_not_rescue_target_on_other_deactivate():
    """
    Деактивация ЛЮБОГО оператора не должна сгрузить touched-лиды
    paused-оператору. Rescue-pool исключает paused наравне с самим
    уходящим.
    """
    leaving = _mk_op("Leaving")
    survivor = _mk_op("Survivor")
    paused = _mk_op("Paused")
    operator_set_paused(operator=paused, paused=True, user=None)

    # У leaving — touched-лид (in_progress).
    touched = _mk_lead_on(leaving, idx=1, status=LeadStatus.IN_PROGRESS)

    operator_deactivate(operator=leaving, user=None)

    touched.refresh_from_db()
    # Rescue-RR должна выбрать survivor, НЕ paused.
    assert touched.operator_id == survivor.id
    assert Lead.objects.filter(operator=paused).count() == 0


# ---------------------------------------------------------------------------
# 3. operator_set_paused(True) НЕ двигает существующие лиды
# ---------------------------------------------------------------------------

@pytest.mark.django_db
def test_pause_does_not_move_existing_leads():
    """
    Ключевое отличие от `operator_deactivate`: пауза не запускает
    rescue-каскад. Лиды оператора остаются у него, статусы не меняются,
    LeadAssignment.count() тот же.
    """
    op = _mk_op("Bonu")
    # Разнообразный микс: untouched, touched, terminal.
    l_new = _mk_lead_on(op, idx=1, status=LeadStatus.NEW)
    l_prog = _mk_lead_on(op, idx=2, status=LeadStatus.IN_PROGRESS)
    l_won = _mk_lead_on(op, idx=3, status=LeadStatus.WON)

    before_assignments = LeadAssignment.objects.filter(lead__in=[l_new, l_prog, l_won]).count()
    before_statuses = {le.id: le.status for le in (l_new, l_prog, l_won)}

    operator_set_paused(operator=op, paused=True, user=None)

    for lead in (l_new, l_prog, l_won):
        lead.refresh_from_db()
        assert lead.operator_id == op.id, f"Lead {lead.id} двинулся с paused оператора"
        assert lead.status == before_statuses[lead.id]

    after_assignments = LeadAssignment.objects.filter(lead__in=[l_new, l_prog, l_won]).count()
    assert after_assignments == before_assignments

    op.refresh_from_db()
    assert op.is_paused is True
    assert op.paused_at is not None
    assert op.status == OperatorStatus.ACTIVE  # пауза ортогональна статусу


# ---------------------------------------------------------------------------
# 4. Unpause возвращает оператора в пул раздачи
# ---------------------------------------------------------------------------

@pytest.mark.django_db
def test_unpause_returns_operator_to_pool():
    op_paused = _mk_op("Snoozer")
    operator_set_paused(operator=op_paused, paused=True, user=None)

    _mk_orphan(1)
    _mk_orphan(2)

    # Пока на паузе — refill пустой.
    assert refill_operator_leads(operator=op_paused, size=5) == []

    # Снимаем паузу.
    operator_set_paused(operator=op_paused, paused=False, user=None)
    op_paused.refresh_from_db()
    assert op_paused.is_paused is False
    assert op_paused.paused_at is None

    delivered = refill_operator_leads(operator=op_paused, size=5)
    assert len(delivered) == 2


# ---------------------------------------------------------------------------
# 5. morning_distribute_leads пропускает paused-операторов
# ---------------------------------------------------------------------------

@pytest.mark.django_db
def test_morning_distribute_excludes_paused():
    active = _mk_op("Active")
    paused = _mk_op("Paused")
    operator_set_paused(operator=paused, paused=True, user=None)

    for i in range(4):
        _mk_orphan(i)

    counts = morning_distribute_leads(seed=42)
    # Все лиды ушли активному, ни один — paused.
    assert counts.get(active.id, 0) == 4
    assert counts.get(paused.id, 0) == 0
    assert Lead.objects.filter(operator=paused).count() == 0


# ---------------------------------------------------------------------------
# 6. bulk_reassign round_robin исключает paused, targeted — разрешает
# ---------------------------------------------------------------------------

@pytest.mark.django_db
def test_bulk_reassign_round_robin_excludes_paused_but_targeted_allows():
    active = _mk_op("Active")
    paused = _mk_op("Paused")
    operator_set_paused(operator=paused, paused=True, user=None)

    orphans = [_mk_orphan(i) for i in range(4)]
    ids = [o.id for o in orphans]

    # RR-режим — paused должен быть исключён.
    result = leads_bulk_reassign(lead_ids=ids, mode="round_robin", user=None)
    assert str(active.id) in result["assigned"]
    assert str(paused.id) not in result["assigned"]
    for lead in orphans:
        lead.refresh_from_db()
        assert lead.operator_id == active.id

    # Targeted (менеджер явно выбрал paused) — разрешаем.
    # Возвращаем в сирот и пробуем ещё раз, но теперь на paused.
    Lead.objects.filter(id__in=ids).update(operator=None, status=LeadStatus.NEW)
    LeadAssignment.objects.filter(lead_id__in=ids).update(active=False)

    result2 = leads_bulk_reassign(lead_ids=ids, operator_id=paused.id, user=None)
    assert result2["total"] == 4
    for lead in orphans:
        lead.refresh_from_db()
        assert lead.operator_id == paused.id


# ---------------------------------------------------------------------------
# 7. Идемпотентность: повторный pause / unpause — no-op
# ---------------------------------------------------------------------------

@pytest.mark.django_db
def test_pause_is_idempotent():
    op = _mk_op("Bonu")
    operator_set_paused(operator=op, paused=True, user=None)
    op.refresh_from_db()
    first_paused_at = op.paused_at

    # Второй вызов с тем же значением — timestamps не меняются.
    operator_set_paused(operator=op, paused=True, user=None)
    op.refresh_from_db()
    assert op.paused_at == first_paused_at

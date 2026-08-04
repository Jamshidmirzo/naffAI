"""
Continuous refill: как только у активного оператора закрывается
(терминализуется) хотя бы один лид, сервис доливает `RR_BATCH_SIZE
- working_count` лидов из общего пула, чтобы держать пачку постоянно
на 5.

Old-style «refill только когда working=0» больше не работает — тесты
здесь адаптированы под новую логику. Полный набор кейсов на рёбрах
(частичное, полное, over-target) — в test_refill_continuous.py.
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
def test_refill_tops_up_to_target_when_other_leads_still_active():
    """
    Continuous-refill: оператор с 2 активными → закрываем 1 → working=1 →
    need=4 → в пуле 20 сирот → доливает 4 → working=5.
    (Раньше здесь ожидалось refill=0; теперь всегда до target.)
    """
    op = Operator.objects.create(full_name="OP", status=OperatorStatus.ACTIVE)
    a = _assign_lead(op, 1)
    _assign_lead(op, 2)  # остаётся активным

    for i in range(20):
        _mk_orphan(i)

    lead_update_status(lead=a, status=LeadStatus.WON)

    # 1 старый assigned + 4 refill (new-статус сирот) = 5 не-терминальных.
    active = Lead.objects.filter(operator=op).exclude(status=LeadStatus.WON)
    assert active.count() == 5
    assert LeadAssignment.objects.filter(
        operator=op, source=LeadAssignmentSource.AUTO_REFILL
    ).count() == 4


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
def test_refill_fires_after_operator_processed_all_leads_today():
    """
    Новое правило «сегодня-плечи»: оператор с 5 assigned-лидами
    сегодня обработал каждый (поставил no_answer / phone_on / …) —
    working_count падает до 0 (все «тронуты сегодня»), поэтому:
      - когда последний терминализуется (или иначе триггерит refill),
        _run_refill_if_empty видит 0 и доливает пачку.

    Здесь эмулируем это: 5 лидов, 4 из них уже переведены сегодня в
    no_answer (carry, не терминал, но «тронут»), пятый переводится в
    WON → срабатывает refill → +5 свежих.
    """
    op = Operator.objects.create(full_name="OP", status=OperatorStatus.ACTIVE)

    # 4 лида уже «отработаны сегодня» — обновлены на текущее время
    # со статусом no_answer.
    for i in range(4):
        Lead.objects.create(
            full_name=f"H-{i}",
            phone=f"+99897{i:07d}",
            status=LeadStatus.NO_ANSWER,
            operator=op,
        )
    # Пятый — «сейчас закрою в won».
    last = _assign_lead(op, 99)

    for i in range(20):
        _mk_orphan(i)

    lead_update_status(lead=last, status=LeadStatus.WON)

    # Итог: 4 no_answer (тронуты сегодня, скрыты из активных) +
    # 1 won (терминал) + 5 свежих из refill = 10 у оператора.
    total = Lead.objects.filter(operator=op).count()
    assert total == 10
    assert LeadAssignment.objects.filter(
        operator=op, source=LeadAssignmentSource.AUTO_REFILL
    ).count() == 5


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

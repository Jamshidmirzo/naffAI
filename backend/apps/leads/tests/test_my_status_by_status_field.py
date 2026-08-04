"""
Задача 39: `by_status` + `total_leads` в `my_status_for_operator`.

Chip-фильтры на странице «Мои лиды» показывают бейдж рядом с названием
статуса. Раньше count считался по локальному массиву `results` (view=active),
поэтому terminal-статусы (contacted_telegram, harid_qildi, …) всегда были 0
— и оператор не жал на chip, думая, что там пусто. По факту у оператора
могли лежать 150 закрытых лидов, которые просто не показывались.

Теперь селектор возвращает `by_status` = {status_code: count} по ВСЕМ
лидам оператора за всё время (без временных фильтров, без postponed_at
фильтра — чистый разрез по status). Фронт использует эти цифры для chip
badges и вызывает отдельный endpoint только при клике.
"""

from __future__ import annotations

import pytest

from apps.leads.models import Lead, LeadStatus
from apps.leads.selectors import my_status_for_operator
from apps.operators.models import Operator, OperatorStatus


def _mk_op(name: str = "OP") -> Operator:
    return Operator.objects.create(full_name=name, status=OperatorStatus.ACTIVE)


def _mk_lead(op: Operator, idx: int, *, status: str) -> Lead:
    return Lead.objects.create(
        full_name=f"L-{idx}",
        phone=f"+99890{idx:07d}",
        status=status,
        operator=op,
    )


@pytest.mark.django_db
def test_by_status_counts_all_operator_leads_including_terminal():
    """5 no_answer + 2 won + 1 assigned → by_status разложен по
    статусам, total = 8. terminal статусы считаются наравне с active."""
    op = _mk_op()
    for i in range(5):
        _mk_lead(op, i, status=LeadStatus.NO_ANSWER)
    for i in range(2):
        _mk_lead(op, 100 + i, status=LeadStatus.WON)  # WON = terminal
    _mk_lead(op, 200, status=LeadStatus.ASSIGNED)

    result = my_status_for_operator(op)

    assert result["by_status"] == {
        LeadStatus.NO_ANSWER: 5,
        LeadStatus.WON: 2,
        LeadStatus.ASSIGNED: 1,
    }
    assert result["total_leads"] == 8


@pytest.mark.django_db
def test_by_status_scoped_to_operator_other_ops_do_not_leak():
    """Лиды другого оператора не попадают в разбивку — фильтр по operator
    строгий (FK equality)."""
    op1 = _mk_op("OP-1")
    op2 = _mk_op("OP-2")
    _mk_lead(op1, 1, status=LeadStatus.ASSIGNED)
    _mk_lead(op1, 2, status=LeadStatus.ASSIGNED)
    _mk_lead(op2, 3, status=LeadStatus.NO_ANSWER)
    _mk_lead(op2, 4, status=LeadStatus.WON)

    result_op1 = my_status_for_operator(op1)
    assert result_op1["by_status"] == {LeadStatus.ASSIGNED: 2}
    assert result_op1["total_leads"] == 2

    result_op2 = my_status_for_operator(op2)
    assert result_op2["by_status"] == {
        LeadStatus.NO_ANSWER: 1,
        LeadStatus.WON: 1,
    }
    assert result_op2["total_leads"] == 2


@pytest.mark.django_db
def test_by_status_empty_operator_returns_empty_dict_and_zero_total():
    op = _mk_op()
    result = my_status_for_operator(op)
    assert result["by_status"] == {}
    assert result["total_leads"] == 0


@pytest.mark.django_db
def test_by_status_includes_postponed_and_terminal_uniformly():
    """postponed_at и is_returned не влияют на by_status — эта разбивка
    отдельная от working/carry/recall. Ключевой инвариант: сумма по by_status
    == total_leads == COUNT всех лидов оператора в БД."""
    from django.utils import timezone

    op = _mk_op()
    _mk_lead(op, 1, status=LeadStatus.ASSIGNED)
    lead2 = _mk_lead(op, 2, status=LeadStatus.NO_ANSWER)
    Lead.objects.filter(pk=lead2.pk).update(postponed_at=timezone.now())
    _mk_lead(op, 3, status=LeadStatus.CONTACTED_TELEGRAM)

    result = my_status_for_operator(op)

    assert result["by_status"] == {
        LeadStatus.ASSIGNED: 1,
        LeadStatus.NO_ANSWER: 1,
        LeadStatus.CONTACTED_TELEGRAM: 1,
    }
    assert result["total_leads"] == 3
    # Инвариант: total == сумма по by_status
    assert result["total_leads"] == sum(result["by_status"].values())

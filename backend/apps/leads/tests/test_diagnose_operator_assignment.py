"""
Тесты для `diagnose_operator_assignment(operator)` — приоритетная
чек-лист-диагностика «почему у оператора X сейчас нет автораздачи».

Матрица: покрываем главные вердикты (auto_distribution_disabled,
empty_pool, quota_full, morning_gate_backlog, healthy_but_idle,
healthy). Порядок должен соответствовать реальному code path в
`operators_eligible_for_new_leads()` + `refill_operator_leads()` —
если баг в приоритете, тесты падают, а не «шифруются» в run-time.
"""

from __future__ import annotations

import datetime as dt

import pytest
from django.utils import timezone

from apps.leads.models import Lead, LeadAssignment, LeadAssignmentSource, LeadStatus
from apps.leads.selectors import (
    diagnose_operator_assignment,
    find_operators_by_freetext,
)
from apps.operators.models import Operator, OperatorStatus


def _mk_op(name: str = "Testop", *, active: bool = True, blocking_gate: bool = False) -> Operator:
    return Operator.objects.create(
        full_name=name,
        status=OperatorStatus.ACTIVE if active else OperatorStatus.INACTIVE,
        blocking_gate_enabled=blocking_gate,
    )


def _mk_working_lead(op: Operator, idx: int, *, status: str = LeadStatus.ASSIGNED) -> Lead:
    """Активный сегодня-non-carry лид → занимает квоту."""
    lead = Lead.objects.create(
        full_name=f"L-{idx}",
        phone=f"+99890{idx:07d}",
        status=status,
        operator=op,
    )
    # updated_at сдвинем в прошлое, чтобы точно попадал под _active_today_filter
    # (условие «updated_at < today_start» ИЛИ status ∈ new/assigned).
    Lead.objects.filter(pk=lead.pk).update(
        updated_at=timezone.now() - dt.timedelta(days=1)
    )
    return lead


def _mk_orphan_pool(count: int) -> list[Lead]:
    """Свободные лиды в общем пуле — операторов нет."""
    return [
        Lead.objects.create(
            full_name=f"orphan-{i}",
            phone=f"+99893{i:07d}",
            status=LeadStatus.NEW,
            operator=None,
        )
        for i in range(count)
    ]


@pytest.mark.django_db
def test_diagnose_auto_distribution_disabled_wins():
    """Killswitch выключен → результат independent от чего-либо."""
    from apps.system_settings.services import system_setting_update

    op = _mk_op()
    _mk_orphan_pool(3)  # даже если пул есть — это не важно
    system_setting_update(auto_distribution_enabled=False)

    diag = diagnose_operator_assignment(op)
    assert diag["verdict"] == "auto_distribution_disabled"
    assert "Автораздача" in diag["verdict_title_ru"]


@pytest.mark.django_db
def test_diagnose_empty_pool():
    """Оператор чистый, но пул пуст → empty_pool."""
    op = _mk_op()
    # working=0, пул=0 → empty_pool
    diag = diagnose_operator_assignment(op)
    assert diag["verdict"] == "empty_pool"
    assert diag["counters"]["pool_size"] == 0


@pytest.mark.django_db
def test_diagnose_quota_full():
    """5 активных сегодняшних лидов → quota_full (main case of Muxlisa)."""
    op = _mk_op()
    _mk_orphan_pool(10)  # пул есть, чтобы empty_pool не победил
    for i in range(5):
        _mk_working_lead(op, i)

    diag = diagnose_operator_assignment(op)
    assert diag["verdict"] == "quota_full"
    assert diag["counters"]["working"] == 5
    assert diag["counters"]["quota"] == 5
    # blocking_leads список отсортирован по updated_at ASC — не должен
    # быть пустым если quota full.
    assert len(diag["blocking_leads"]) == 5


@pytest.mark.django_db
def test_diagnose_operator_not_active():
    """Uninактивный оператор → operator_not_active даже с пустой квотой."""
    op = _mk_op(active=False)
    _mk_orphan_pool(3)

    diag = diagnose_operator_assignment(op)
    assert diag["verdict"] == "operator_not_active"


@pytest.mark.django_db
def test_diagnose_healthy_but_idle():
    """
    Всё зелёное, но за 24ч не было ни одного авто-assignment'а →
    healthy_but_idle. Демонстрирует случай «утренняя раздача прошла,
    новых нет, пул тонкий».
    """
    op = _mk_op()
    _mk_orphan_pool(2)  # маленький пул, но не 0 (иначе empty_pool)
    # Никаких LeadAssignment за 24ч — recent_assignments={}.
    diag = diagnose_operator_assignment(op)
    assert diag["verdict"] == "healthy_but_idle"


@pytest.mark.django_db
def test_diagnose_healthy_when_recent_auto_delivery():
    """
    Пул есть, квота свободна, за 24ч приходил `auto_refill` → healthy.
    """
    op = _mk_op()
    _mk_orphan_pool(2)
    LeadAssignment.objects.create(
        lead=_mk_working_lead(op, 999),
        operator=op,
        source=LeadAssignmentSource.AUTO_REFILL,
        active=True,
        reason="test",
    )
    # working=1 (мы создали lead), но < quota → healthy
    diag = diagnose_operator_assignment(op)
    assert diag["verdict"] == "healthy"
    assert diag["recent_assignments"].get("auto_refill") == 1


@pytest.mark.django_db
def test_find_operators_by_freetext_by_name():
    Operator.objects.create(full_name="Muxlisa", status=OperatorStatus.ACTIVE)
    Operator.objects.create(full_name="Mushtariy", status=OperatorStatus.ACTIVE)
    Operator.objects.create(full_name="Diyana", status=OperatorStatus.ACTIVE)

    hits = find_operators_by_freetext("muxli")
    assert len(hits) == 1
    assert hits[0].full_name == "Muxlisa"


@pytest.mark.django_db
def test_find_operators_by_freetext_cyrillic():
    Operator.objects.create(full_name="Muxlisa", status=OperatorStatus.ACTIVE)
    Operator.objects.create(full_name="Mushtariy", status=OperatorStatus.ACTIVE)

    hits = find_operators_by_freetext("Мухлиса")
    assert [h.full_name for h in hits] == ["Muxlisa"]

    hits = find_operators_by_freetext("муштарий")
    assert [h.full_name for h in hits] == ["Mushtariy"]


@pytest.mark.django_db
def test_find_operators_by_freetext_h_x_variants():
    Operator.objects.create(full_name="Muxlisa", status=OperatorStatus.ACTIVE)
    hits = find_operators_by_freetext("muhlisa")
    assert [h.full_name for h in hits] == ["Muxlisa"]


@pytest.mark.django_db
def test_find_operators_by_freetext_id_wins():
    op = Operator.objects.create(full_name="Foo", status=OperatorStatus.ACTIVE)
    hits = find_operators_by_freetext(str(op.id))
    assert len(hits) == 1
    assert hits[0].pk == op.pk


@pytest.mark.django_db
def test_find_operators_by_freetext_ambiguous():
    Operator.objects.create(full_name="Muxlisa", status=OperatorStatus.ACTIVE)
    Operator.objects.create(full_name="Mushtariy", status=OperatorStatus.ACTIVE)
    hits = find_operators_by_freetext("mu")
    # Оба матчатся по 'mu'.
    assert len(hits) == 2

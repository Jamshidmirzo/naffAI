"""
`SystemSetting.morning_split_cap` ограничивает выдачу одному оператору
за одну утреннюю раздачу. Пул 21 / 1 активный оператор при cap=5 → 5
назначено, 16 остаются в пуле и «доедут» через refill в течение дня.

Отдельный файл, чтобы не смешивать с базовыми round-robin тестами
(`test_morning_distribute.py`), которые проверяют семантику без cap
(они всё ещё зелёные — дефолт 5 не влияет на пулы ≤ 5 на оператора).
"""

from __future__ import annotations

import pytest

from apps.leads.models import Lead, LeadStatus
from apps.leads.services import morning_distribute_leads
from apps.operators.models import Operator, OperatorStatus
from apps.system_settings.models import SystemSetting


def _mk_op(name: str) -> Operator:
    return Operator.objects.create(full_name=name, status=OperatorStatus.ACTIVE)


def _mk_orphan(idx: int) -> Lead:
    return Lead.objects.create(
        full_name=f"Cap-{idx}",
        phone=f"+9989{idx:08d}",
        status=LeadStatus.NEW,
        operator=None,
    )


@pytest.mark.django_db
def test_default_cap_is_5_with_21_leads_and_1_operator():
    """Основной кейс от пользователя: 21 лид в пуле, 1 активный оператор.

    С дефолтным cap=5 → оператор получает ровно 5, 16 остаются
    сиротами."""

    op = _mk_op("Solo")
    for i in range(21):
        _mk_orphan(i)

    counts = morning_distribute_leads(seed=0)

    assert counts[op.id] == 5
    assert Lead.objects.filter(operator__isnull=True).count() == 16
    assert Lead.objects.filter(operator=op).count() == 5


@pytest.mark.django_db
def test_cap_applied_dry_run():
    op = _mk_op("Solo")
    for i in range(21):
        _mk_orphan(i)

    counts = morning_distribute_leads(seed=0, dry_run=True)

    assert counts[op.id] == 5
    # Ничего не назначено — dry_run.
    assert Lead.objects.filter(operator__isnull=True).count() == 21


@pytest.mark.django_db
def test_cap_zero_means_unlimited():
    """0 → выкл. лимит (легаси-поведение «делим всё поровну»)."""

    s = SystemSetting.get_solo()
    s.morning_split_cap = 0
    s.save(update_fields=["morning_split_cap"])

    op = _mk_op("Solo")
    for i in range(21):
        _mk_orphan(i)

    counts = morning_distribute_leads(seed=0)

    assert counts[op.id] == 21
    assert Lead.objects.filter(operator__isnull=True).count() == 0


@pytest.mark.django_db
def test_cap_respected_across_multiple_operators():
    """Пул 21 / 3 активных оператора / cap=5 → каждому 5, остаётся 6."""

    ops = [_mk_op(f"Op-{i}") for i in range(3)]
    for i in range(21):
        _mk_orphan(i)

    counts = morning_distribute_leads(seed=0)

    assert sum(counts.values()) == 15
    for op in ops:
        assert counts[op.id] == 5
    assert Lead.objects.filter(operator__isnull=True).count() == 6


@pytest.mark.django_db
def test_custom_cap_setting():
    s = SystemSetting.get_solo()
    s.morning_split_cap = 3
    s.save(update_fields=["morning_split_cap"])

    op = _mk_op("Solo")
    for i in range(10):
        _mk_orphan(i)

    counts = morning_distribute_leads(seed=0)

    assert counts[op.id] == 3
    assert Lead.objects.filter(operator__isnull=True).count() == 7

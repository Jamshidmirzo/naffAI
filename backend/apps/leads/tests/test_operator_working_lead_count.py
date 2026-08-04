"""
`operator_working_lead_count(op)` — «сегодня-плечи» оператора: активные,
не терминальные, **не carry-статус**, не отложенные лиды, ещё не
тронутые сегодня.

Правила (2026-08-04 обновление):
  1. Untouched (new / assigned) — всегда в счёте.
  2. Тронут сегодня → из счёта уходит (по правилу «сегодня-плечи»).
  3. **Carry-статус (no_answer / phone_on / callback_scheduled / …) —
     из счёта уходит НАВСЕГДА**, потому что carry-лиды хранятся в
     отдельном хвосте (всплывут завтра), не блокируют квоту RR.

Это фидит квоту: `operators_eligible_for_new_leads` считает
`_working_count < RR_BATCH_SIZE`. Если у Bonu 30 no_answer'ов (carry) —
её working=0, RR доливает 5 свежих. Carry-лиды видны отдельно на /my.
"""

from __future__ import annotations

import datetime as dt

import pytest
from django.utils import timezone

from apps.leads.models import Lead, LeadStatus
from apps.leads.selectors import operator_working_lead_count
from apps.operators.models import Operator, OperatorStatus


def _mk_op() -> Operator:
    return Operator.objects.create(full_name="OP", status=OperatorStatus.ACTIVE)


def _mk_lead(
    op: Operator,
    idx: int,
    *,
    status: str = LeadStatus.ASSIGNED,
    updated_days_ago: int = 0,
    postponed: bool = False,
) -> Lead:
    """
    Создать лид у оператора и вручную сдвинуть `updated_at`.
    `updated_days_ago=0` — обновлён сейчас (сегодня), `=1` — вчера, ...
    """
    lead = Lead.objects.create(
        full_name=f"L-{idx}",
        phone=f"+99890{idx:07d}",
        status=status,
        operator=op,
        postponed_at=timezone.now() if postponed else None,
    )
    now = timezone.now()
    Lead.objects.filter(pk=lead.pk).update(
        updated_at=now - dt.timedelta(days=updated_days_ago)
    )
    lead.refresh_from_db()
    return lead


@pytest.mark.django_db
def test_untouched_assigned_today_counts():
    """Свежий `assigned`, RR раздал его 5 минут назад → должен считаться."""
    op = _mk_op()
    _mk_lead(op, 1, status=LeadStatus.ASSIGNED, updated_days_ago=0)
    assert operator_working_lead_count(op) == 1


@pytest.mark.django_db
def test_new_status_today_counts():
    """Статус `new` (не тронут оператором) — считается даже если updated сегодня."""
    op = _mk_op()
    _mk_lead(op, 1, status=LeadStatus.NEW, updated_days_ago=0)
    assert operator_working_lead_count(op) == 1


@pytest.mark.django_db
def test_touched_today_carry_status_not_counted():
    """
    Оператор сегодня поставил no_answer → carry, не в счёте.
    (После 2026-08-04 работает по двум причинам: и «carry excluded»,
    и «тронут сегодня». Раньше — только по второй.)
    """
    op = _mk_op()
    _mk_lead(op, 1, status=LeadStatus.NO_ANSWER, updated_days_ago=0)
    assert operator_working_lead_count(op) == 0


@pytest.mark.django_db
def test_touched_yesterday_carry_status_not_counted():
    """
    Новое правило: carry-статус (no_answer) НЕ входит в квоту, никогда.
    Ни сегодня-тронутый, ни вчерашний — они хранятся отдельно.
    Оператор увидит их на /my (в carry-хвосте), но working=0.
    """
    op = _mk_op()
    _mk_lead(op, 1, status=LeadStatus.NO_ANSWER, updated_days_ago=1)
    assert operator_working_lead_count(op) == 0


@pytest.mark.django_db
def test_mixed_case_docstring_example():
    """
    3 лида у оператора:
      - 1 assigned, updated сегодня → в счёте (untouched, non-carry)
      - 1 no_answer, updated вчера → НЕ в счёте (carry-хвост, не блокирует)
      - 1 no_answer, updated сегодня → НЕ в счёте (carry-хвост)
    Ожидание: working = 1.
    """
    op = _mk_op()
    _mk_lead(op, 1, status=LeadStatus.ASSIGNED, updated_days_ago=0)
    _mk_lead(op, 2, status=LeadStatus.NO_ANSWER, updated_days_ago=1)
    _mk_lead(op, 3, status=LeadStatus.NO_ANSWER, updated_days_ago=0)

    assert operator_working_lead_count(op) == 1


@pytest.mark.django_db
def test_all_carry_yields_zero_working():
    """
    Реалистичный «залипший» кейс из прода: у оператора 30+ carry-лидов
    и ноль свежих. Раньше working≥30 → RR никогда не доливал, оператор
    сидел без работы. Теперь: working=0, оператор eligible на 5 новых.
    """
    op = _mk_op()
    for i in range(30):
        _mk_lead(op, i, status=LeadStatus.NO_ANSWER, updated_days_ago=1)
    for i in range(30, 35):
        _mk_lead(op, i, status=LeadStatus.PHONE_ON, updated_days_ago=2)
    for i in range(35, 40):
        _mk_lead(op, i, status=LeadStatus.CALLBACK_SCHEDULED, updated_days_ago=1)
    assert operator_working_lead_count(op) == 0


@pytest.mark.django_db
def test_carry_touched_today_still_not_counted():
    """Сегодня поставил no_answer — carry, не в счёте (тронут ИЛИ carry)."""
    op = _mk_op()
    _mk_lead(op, 1, status=LeadStatus.NO_ANSWER, updated_days_ago=0)
    assert operator_working_lead_count(op) == 0


@pytest.mark.django_db
def test_only_todays_assigned_and_todays_no_answer():
    """
    - сегодняшний assigned → +1
    - сегодняшний no_answer → 0
    Итого: 1.
    """
    op = _mk_op()
    _mk_lead(op, 1, status=LeadStatus.ASSIGNED, updated_days_ago=0)
    _mk_lead(op, 2, status=LeadStatus.NO_ANSWER, updated_days_ago=0)

    assert operator_working_lead_count(op) == 1


@pytest.mark.django_db
def test_postponed_lead_not_counted():
    """Отложенный лид (postponed_at IS NOT NULL) — не в счёте, всегда."""
    op = _mk_op()
    _mk_lead(op, 1, status=LeadStatus.ASSIGNED, updated_days_ago=1, postponed=True)
    assert operator_working_lead_count(op) == 0


@pytest.mark.django_db
def test_terminal_won_not_counted():
    """Терминальный (won) — не в счёте, даже если updated вчера."""
    op = _mk_op()
    _mk_lead(op, 1, status=LeadStatus.WON, updated_days_ago=1)
    assert operator_working_lead_count(op) == 0


@pytest.mark.django_db
def test_terminal_lost_not_counted():
    op = _mk_op()
    _mk_lead(op, 1, status=LeadStatus.LOST, updated_days_ago=1)
    assert operator_working_lead_count(op) == 0

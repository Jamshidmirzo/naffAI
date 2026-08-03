"""
`operator_working_lead_count(op)` — «сегодня-плечи» оператора: активные,
не терминальные, не отложенные лиды, **которые он ещё не тронул сегодня**.

Правило: как только оператор поставил любой статус (включая carry_over
типа no_answer/phone_on/dokonga_keladi) — лид «отработан на сегодня» и
из счётчика уходит. Завтра `updated_at < today_start` → лид снова в счёте.

Это правило фидит квоту RR: `operators_eligible_for_new_leads` считает
именно `_working_count < RR_BATCH_SIZE`, поэтому если Bonu утром закрыла
пачку 5 — вечером её счётчик всё ещё будет 0 (все 5 «тронуты сегодня»)
и RR может долить свежих.
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
    Ключевое: оператор сегодня поставил no_answer → лид «отработан»,
    из счётчика уходит. Завтра всплывёт обратно.
    """
    op = _mk_op()
    _mk_lead(op, 1, status=LeadStatus.NO_ANSWER, updated_days_ago=0)
    assert operator_working_lead_count(op) == 0


@pytest.mark.django_db
def test_touched_yesterday_carry_status_counts():
    """Вчера поставил no_answer — сегодня утром снова в счёте (carry-over)."""
    op = _mk_op()
    _mk_lead(op, 1, status=LeadStatus.NO_ANSWER, updated_days_ago=1)
    assert operator_working_lead_count(op) == 1


@pytest.mark.django_db
def test_mixed_case_docstring_example():
    """
    3 лида у оператора:
      - 1 assigned, updated сегодня → в счёте (untouched)
      - 1 no_answer, updated вчера → в счёте (carry, не тронут сегодня)
      - 1 no_answer, updated сегодня → НЕ в счёте (тронут сегодня)
    Ожидание: working = 2.
    """
    op = _mk_op()
    _mk_lead(op, 1, status=LeadStatus.ASSIGNED, updated_days_ago=0)
    _mk_lead(op, 2, status=LeadStatus.NO_ANSWER, updated_days_ago=1)
    _mk_lead(op, 3, status=LeadStatus.NO_ANSWER, updated_days_ago=0)

    assert operator_working_lead_count(op) == 2


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

"""
`operator_deactivate(rescue_touched=True)` — новое поведение:
untouched → пул через round-robin (как раньше), touched non-terminal —
`operator=NULL + needs_review=True` (было: остаются на уволенном).

Также `rescue_touched=False` — legacy path для обратной совместимости.
"""

from __future__ import annotations

import pytest

from apps.leads.models import Lead, LeadAssignment, LeadStatus
from apps.operators.models import Operator, OperatorStatus
from apps.operators.services import operator_deactivate


def _mk_op(name: str, status: str = OperatorStatus.ACTIVE) -> Operator:
    return Operator.objects.create(full_name=name, status=status)


def _mk_lead(operator: Operator | None, *, idx: int, status: str) -> Lead:
    lead = Lead.objects.create(
        full_name=f"L-{idx}",
        phone=f"+99890{idx:07d}",
        status=status,
        operator=operator,
    )
    if operator is not None:
        LeadAssignment.objects.create(
            lead=lead, operator=operator, source="admin_reassign", active=True
        )
    return lead


@pytest.mark.django_db
def test_deactivate_default_rescues_touched_to_needs_review():
    leaving = _mk_op("Leaving")
    survivor = _mk_op("Survivor")

    untouched = _mk_lead(leaving, idx=1, status=LeadStatus.NEW)
    touched = _mk_lead(leaving, idx=2, status=LeadStatus.IN_PROGRESS)
    no_answer = _mk_lead(leaving, idx=3, status=LeadStatus.NO_ANSWER)
    phone_on = _mk_lead(leaving, idx=4, status=LeadStatus.PHONE_ON)
    won = _mk_lead(leaving, idx=5, status=LeadStatus.WON)  # terminal — не трогаем

    op = operator_deactivate(operator=leaving, user=None)

    assert op.status == OperatorStatus.INACTIVE
    # Untouched — уехали на survivor (round-robin).
    untouched.refresh_from_db()
    assert untouched.operator_id == survivor.id
    assert untouched.needs_review is False
    # Touched non-terminal — operator=NULL, needs_review=True, статус СОХРАНЁН.
    for lead in (touched, no_answer, phone_on):
        lead.refresh_from_db()
        assert lead.operator_id is None
        assert lead.needs_review is True
    assert touched.status == LeadStatus.IN_PROGRESS
    assert no_answer.status == LeadStatus.NO_ANSWER
    assert phone_on.status == LeadStatus.PHONE_ON
    # Terminal — не тронут.
    won.refresh_from_db()
    assert won.operator_id == leaving.id

    # Счётчики на возвращённом объекте.
    assert op.rebalanced_count == 1
    assert op.touched_needs_review_count == 3


@pytest.mark.django_db
def test_deactivate_rescue_false_keeps_touched_on_inactive_operator():
    leaving = _mk_op("Leaving")
    _mk_op("Survivor")  # чтобы untouched-round-robin отработал

    untouched = _mk_lead(leaving, idx=1, status=LeadStatus.NEW)
    touched = _mk_lead(leaving, idx=2, status=LeadStatus.IN_PROGRESS)

    op = operator_deactivate(operator=leaving, user=None, rescue_touched=False)

    assert op.status == OperatorStatus.INACTIVE
    untouched.refresh_from_db()
    touched.refresh_from_db()
    # Untouched уехал по round-robin.
    assert untouched.operator_id != leaving.id
    # Touched — остался на уволенном (legacy path).
    assert touched.operator_id == leaving.id
    assert touched.needs_review is False
    assert op.touched_needs_review_count == 0


@pytest.mark.django_db
def test_deactivate_with_no_survivors_still_rescues():
    """
    Нет других активных операторов → round-robin untouched некому
    передать. Но rescue-fallback (rescue_touched=True, default) всё равно
    отвяжет untouched в пул (operator=NULL) и touched в needs_review —
    им не нужен другой оператор. Это лучше, чем legacy-поведение,
    когда всё оставалось висеть на уволенном.
    """
    leaving = _mk_op("OnlyOne")

    touched = _mk_lead(leaving, idx=1, status=LeadStatus.IN_PROGRESS)
    untouched = _mk_lead(leaving, idx=2, status=LeadStatus.NEW)

    op = operator_deactivate(operator=leaving, user=None)

    touched.refresh_from_db()
    untouched.refresh_from_db()
    # Round-robin не сработал (некому раздать), но rescue-fallback
    # отвязал untouched в пул.
    assert untouched.operator_id is None
    assert untouched.needs_review is False
    # Touched — в needs_review.
    assert touched.operator_id is None
    assert touched.needs_review is True
    assert op.touched_needs_review_count == 1


@pytest.mark.django_db
def test_deactivate_no_survivors_and_rescue_false_leaves_everything():
    """
    Legacy path (rescue_touched=False) + нет других активных → всё остаётся
    на уволенном. Обратная совместимость.
    """
    leaving = _mk_op("OnlyOne")
    touched = _mk_lead(leaving, idx=1, status=LeadStatus.IN_PROGRESS)
    untouched = _mk_lead(leaving, idx=2, status=LeadStatus.NEW)

    op = operator_deactivate(operator=leaving, user=None, rescue_touched=False)

    touched.refresh_from_db()
    untouched.refresh_from_db()
    assert touched.operator_id == leaving.id
    assert untouched.operator_id == leaving.id
    assert op.touched_needs_review_count == 0

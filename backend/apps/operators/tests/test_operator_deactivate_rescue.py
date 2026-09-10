"""
`operator_deactivate` — cascade behaviour tests (2026-09-10 rewrite).

New default (`mode="reassign"`):
    Touched non-terminal лиды при деактивации оператора **round-robin**
    раскидываются другому активному оператору с сохранением статуса,
    metadata и call history. Никакой массовой отправки в LOST —
    это причина того, что за 7 дней в system_lost ушло 3891 лидов.

Legacy режим (`mode="mark_lost"`):
    Прошлое поведение — touched non-terminal → `status='lost'` +
    `metadata['lost_reason']='stranded_on_inactive_operator'`.
    Сохранён как escape hatch (напр., массовое закрытие уходящего
    оператора когда менеджер явно не хочет передавать хвост).

Fallback (`rescue_touched=False`):
    Полный legacy — touched-лиды не трогаем совсем.
"""

from __future__ import annotations

import pytest

from apps.calls.models import CallbackReminder, CallbackReminderStatus
from apps.leads.models import Lead, LeadAssignment, LeadAssignmentSource, LeadStatus
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


# ---------------------------------------------------------------------------
# Wave 1: new default — reassign
# ---------------------------------------------------------------------------

@pytest.mark.django_db
def test_deactivate_default_reassigns_touched_to_active_operator():
    """Touched non-terminal лиды → на другого активного оператора
    с сохранением статуса и metadata-audit."""
    leaving = _mk_op("Leaving")
    survivor = _mk_op("Survivor")

    untouched = _mk_lead(leaving, idx=1, status=LeadStatus.NEW)
    touched = _mk_lead(leaving, idx=2, status=LeadStatus.IN_PROGRESS)
    no_answer = _mk_lead(leaving, idx=3, status=LeadStatus.NO_ANSWER)
    phone_on = _mk_lead(leaving, idx=4, status=LeadStatus.PHONE_ON)
    won = _mk_lead(leaving, idx=5, status=LeadStatus.WON)  # terminal — не трогаем

    op = operator_deactivate(operator=leaving, user=None)

    assert op.status == OperatorStatus.INACTIVE

    # Untouched — на survivor (round-robin в основном untouched-rebalance).
    untouched.refresh_from_db()
    assert untouched.operator_id == survivor.id
    assert untouched.status == LeadStatus.ASSIGNED  # RR ставит ASSIGNED

    # Touched non-terminal — переехали к survivor с СОХРАНЁННЫМ статусом.
    for lead, expected_status in (
        (touched, LeadStatus.IN_PROGRESS),
        (no_answer, LeadStatus.NO_ANSWER),
        (phone_on, LeadStatus.PHONE_ON),
    ):
        lead.refresh_from_db()
        assert lead.operator_id == survivor.id
        assert lead.status == expected_status  # статус НЕ меняли
        md = lead.metadata or {}
        assert md.get("rescued_touched_at")
        assert md["rescued_from_operator_name"] == "Leaving"
        assert md["rescued_to_operator_name"] == "Survivor"
        assert md["rescued_from_operator_id"] == leaving.id
        assert md["rescued_to_operator_id"] == survivor.id
        assert md["rescued_reason"] == "operator_deactivated"
        # НЕТ старого lost_reason (это reassign, не mark_lost).
        assert "lost_reason" not in md

        # Активное LeadAssignment — с AUTO_RESCUE_TOUCHED source.
        new_assn = lead.assignments.filter(active=True).first()
        assert new_assn is not None
        assert new_assn.operator_id == survivor.id
        assert new_assn.source == LeadAssignmentSource.AUTO_RESCUE_TOUCHED

    # Terminal (won) — не тронут.
    won.refresh_from_db()
    assert won.operator_id == leaving.id

    # Счётчики на возвращённом объекте.
    assert op.touched_reassigned_count == 3
    assert op.touched_system_lost_count == 0
    # Обратная совместимость: старое имя = сколько touched-лидов «изъяли».
    assert op.touched_needs_review_count == 3


@pytest.mark.django_db
def test_deactivate_reassign_does_not_return_leads_to_leaving_operator():
    """Rescue-RR НИКОГДА не даёт лидов деактивированному самому себе."""
    leaving = _mk_op("Leaving")
    survivor = _mk_op("Survivor")

    touched = _mk_lead(leaving, idx=1, status=LeadStatus.IN_PROGRESS)

    operator_deactivate(operator=leaving, user=None)

    touched.refresh_from_db()
    assert touched.operator_id == survivor.id
    assert touched.operator_id != leaving.id


@pytest.mark.django_db
def test_deactivate_reassign_moves_callback_reminders():
    """CallbackReminder на touched-лидах переезжает на нового владельца,
    dm_sent_at сбрасывается."""
    from django.utils import timezone as djtz

    leaving = _mk_op("Leaving")
    survivor = _mk_op("Survivor")

    lead = _mk_lead(leaving, idx=1, status=LeadStatus.CALLBACK_SCHEDULED)
    cb = CallbackReminder.objects.create(
        lead=lead,
        operator=leaving,
        remind_at=djtz.now(),
        status=CallbackReminderStatus.PENDING,
        dm_sent_at=djtz.now(),
    )

    operator_deactivate(operator=leaving, user=None)

    cb.refresh_from_db()
    assert cb.operator_id == survivor.id
    assert cb.dm_sent_at is None


@pytest.mark.django_db
def test_deactivate_reassign_load_balances_across_pool():
    """Round-robin даёт наименее загруженному, не одному оператору всё."""
    leaving = _mk_op("Leaving")
    survivor_a = _mk_op("SurvivorA")
    survivor_b = _mk_op("SurvivorB")

    # Пять touched-лидов от leaving.
    leads = [_mk_lead(leaving, idx=i, status=LeadStatus.IN_PROGRESS) for i in range(1, 6)]

    operator_deactivate(operator=leaving, user=None)

    counts = {survivor_a.id: 0, survivor_b.id: 0}
    for lead in leads:
        lead.refresh_from_db()
        assert lead.operator_id in counts
        counts[lead.operator_id] += 1

    # Оба выжившие получили минимум по одному, разница ≤ 1 (RR fair).
    assert min(counts.values()) >= 1
    assert max(counts.values()) - min(counts.values()) <= 1


# ---------------------------------------------------------------------------
# Wave 1: legacy mode="mark_lost"
# ---------------------------------------------------------------------------

@pytest.mark.django_db
def test_deactivate_mark_lost_mode_preserves_legacy_behavior():
    """mode='mark_lost' → touched non-terminal → status=LOST."""
    leaving = _mk_op("Leaving")
    _mk_op("Survivor")  # чтобы untouched-round-robin отработал

    untouched = _mk_lead(leaving, idx=1, status=LeadStatus.NEW)
    touched = _mk_lead(leaving, idx=2, status=LeadStatus.IN_PROGRESS)
    no_answer = _mk_lead(leaving, idx=3, status=LeadStatus.NO_ANSWER)
    won = _mk_lead(leaving, idx=4, status=LeadStatus.WON)

    op = operator_deactivate(operator=leaving, user=None, mode="mark_lost")

    # Untouched — уехали по RR (не изменилось).
    untouched.refresh_from_db()
    assert untouched.operator_id != leaving.id

    # Touched — в LOST с metadata (legacy path).
    for lead in (touched, no_answer):
        lead.refresh_from_db()
        assert lead.operator_id is None
        assert lead.status == LeadStatus.LOST
        md = lead.metadata or {}
        assert md["lost_reason"] == "stranded_on_inactive_operator"
        assert md["lost_original_operator_name"] == "Leaving"

    # Terminal — не тронут.
    won.refresh_from_db()
    assert won.operator_id == leaving.id

    assert op.touched_system_lost_count == 2
    assert op.touched_reassigned_count == 0
    assert op.touched_needs_review_count == 2


# ---------------------------------------------------------------------------
# Wave 1: rescue_touched=False (полный legacy)
# ---------------------------------------------------------------------------

@pytest.mark.django_db
def test_deactivate_rescue_false_keeps_touched_on_inactive_operator():
    leaving = _mk_op("Leaving")
    _mk_op("Survivor")

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
    assert touched.status == LeadStatus.IN_PROGRESS
    assert (touched.metadata or {}).get("lost_reason") is None
    assert op.touched_needs_review_count == 0
    assert op.touched_reassigned_count == 0


# ---------------------------------------------------------------------------
# Wave 1: нет выживших активных
# ---------------------------------------------------------------------------

@pytest.mark.django_db
def test_deactivate_reassign_no_survivors_falls_back_to_system_lost():
    """Нет активных операторов кроме уходящего → некому передать touched.
    Fallback: пометить как system-lost (лучше чем оставить на уволенном)."""
    leaving = _mk_op("OnlyOne")

    touched = _mk_lead(leaving, idx=1, status=LeadStatus.IN_PROGRESS)
    untouched = _mk_lead(leaving, idx=2, status=LeadStatus.NEW)

    op = operator_deactivate(operator=leaving, user=None)

    touched.refresh_from_db()
    untouched.refresh_from_db()
    # Untouched — в общий пул (operator=NULL).
    assert untouched.operator_id is None
    assert untouched.status == LeadStatus.NEW
    # Touched — fallback в system-lost.
    assert touched.operator_id is None
    assert touched.status == LeadStatus.LOST
    md = touched.metadata or {}
    assert md["lost_reason"] == "stranded_on_inactive_operator"
    assert op.touched_system_lost_count == 1
    assert op.touched_reassigned_count == 0


@pytest.mark.django_db
def test_deactivate_no_survivors_and_rescue_false_leaves_everything():
    """Полный legacy path: rescue_touched=False + нет активных
    → всё остаётся на уволенном."""
    leaving = _mk_op("OnlyOne")
    touched = _mk_lead(leaving, idx=1, status=LeadStatus.IN_PROGRESS)
    untouched = _mk_lead(leaving, idx=2, status=LeadStatus.NEW)

    op = operator_deactivate(operator=leaving, user=None, rescue_touched=False)

    touched.refresh_from_db()
    untouched.refresh_from_db()
    assert touched.operator_id == leaving.id
    assert untouched.operator_id == leaving.id
    assert op.touched_needs_review_count == 0

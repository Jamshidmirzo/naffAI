"""
Rescue пропавших лидов на уволенных операторах:
`rescue_stranded_leads_for_operator` (service) +
`rescue_stranded_leads` (management-команда) +
селекторы `stranded_untouched_leads`, `stranded_touched_non_terminal_leads`,
`stranded_on_inactive_operators`, `needs_review_leads`.

Правила:
  * untouched (new/assigned) на inactive → operator=NULL (в пул).
  * touched non-terminal (in_progress, no_answer, phone_on, has_debt, ...)
    на inactive → operator=NULL + needs_review=True (статус СОХРАНЯЕТСЯ).
  * terminal (won/lost/archived/needs_review-на-активе) — не трогаем.
  * лиды на активных операторах — не трогаем.
  * идемпотентно: повторный run — ничего не находит.
  * dry-run печатает те же цифры, но не UPDATE'ит.
"""

from __future__ import annotations

from io import StringIO

import pytest
from django.core.management import call_command

from apps.audit.models import AuditAction, AuditLog
from apps.leads.models import (
    Lead,
    LeadAssignment,
    LeadAssignmentSource,
    LeadStatus,
)
from apps.leads.selectors import (
    needs_review_leads,
    stranded_on_inactive_operators,
    stranded_touched_non_terminal_leads,
    stranded_untouched_leads,
)
from apps.leads.services import rescue_stranded_leads_for_operator
from apps.operators.models import Operator, OperatorStatus


def _mk_op(name: str, status: str = OperatorStatus.INACTIVE) -> Operator:
    return Operator.objects.create(full_name=name, status=status)


def _mk_lead(
    operator: Operator | None,
    *,
    idx: int,
    status: str = LeadStatus.NEW,
    needs_review: bool = False,
) -> Lead:
    lead = Lead.objects.create(
        full_name=f"L-{idx}",
        phone=f"+99890{idx:07d}",
        status=status,
        operator=operator,
        needs_review=needs_review,
    )
    # Симулируем «текущий» active assignment на inactive-операторе — чтобы
    # rescue корректно закрыл его active=False.
    if operator is not None:
        LeadAssignment.objects.create(
            lead=lead,
            operator=operator,
            source=LeadAssignmentSource.ADMIN_REASSIGN,
            active=True,
        )
    return lead


# ---------- Селекторы -----------------------------------------------------


@pytest.mark.django_db
def test_selector_untouched_finds_only_new_assigned_on_inactive():
    inactive = _mk_op("Inactive1", OperatorStatus.INACTIVE)
    active = _mk_op("Active1", OperatorStatus.ACTIVE)

    lead_new = _mk_lead(inactive, idx=1, status=LeadStatus.NEW)
    lead_assigned = _mk_lead(inactive, idx=2, status=LeadStatus.ASSIGNED)
    lead_touched = _mk_lead(inactive, idx=3, status=LeadStatus.IN_PROGRESS)
    _mk_lead(inactive, idx=4, status=LeadStatus.WON)  # terminal — исключён
    _mk_lead(active, idx=5, status=LeadStatus.NEW)  # активный — исключён

    ids = set(stranded_untouched_leads().values_list("id", flat=True))
    assert ids == {lead_new.id, lead_assigned.id}
    assert lead_touched.id not in ids


@pytest.mark.django_db
def test_selector_touched_non_terminal_excludes_untouched_and_terminal():
    inactive = _mk_op("Inactive2", OperatorStatus.INACTIVE)
    active = _mk_op("Active2", OperatorStatus.ACTIVE)

    _mk_lead(inactive, idx=1, status=LeadStatus.NEW)  # untouched
    lead_in_progress = _mk_lead(inactive, idx=2, status=LeadStatus.IN_PROGRESS)
    lead_no_answer = _mk_lead(inactive, idx=3, status=LeadStatus.NO_ANSWER)
    lead_phone_on = _mk_lead(inactive, idx=4, status=LeadStatus.PHONE_ON)
    _mk_lead(inactive, idx=5, status=LeadStatus.WON)  # terminal
    _mk_lead(inactive, idx=6, status=LeadStatus.LOST)  # terminal
    _mk_lead(active, idx=7, status=LeadStatus.IN_PROGRESS)  # не на inactive

    ids = set(stranded_touched_non_terminal_leads().values_list("id", flat=True))
    assert ids == {lead_in_progress.id, lead_no_answer.id, lead_phone_on.id}


@pytest.mark.django_db
def test_selector_union_stranded_matches_untouched_plus_touched():
    inactive = _mk_op("Inactive3", OperatorStatus.INACTIVE)
    _mk_lead(inactive, idx=1, status=LeadStatus.NEW)
    _mk_lead(inactive, idx=2, status=LeadStatus.ASSIGNED)
    _mk_lead(inactive, idx=3, status=LeadStatus.IN_PROGRESS)
    _mk_lead(inactive, idx=4, status=LeadStatus.HAS_DEBT)
    _mk_lead(inactive, idx=5, status=LeadStatus.WON)  # исключается

    stranded = stranded_on_inactive_operators().count()
    untouched = stranded_untouched_leads().count()
    touched = stranded_touched_non_terminal_leads().count()

    # Union = untouched ∪ touched, все три не пересекаются.
    assert stranded == 4
    assert untouched == 2
    assert touched == 2
    assert stranded == untouched + touched


@pytest.mark.django_db
def test_selector_needs_review_only_finds_needs_review_orphans():
    _mk_lead(None, idx=1, status=LeadStatus.NEEDS_REVIEW, needs_review=True)
    _mk_lead(None, idx=2, status=LeadStatus.NEW, needs_review=True)
    active = _mk_op("A", OperatorStatus.ACTIVE)
    _mk_lead(active, idx=3, status=LeadStatus.NEW, needs_review=True)  # не сирота
    _mk_lead(None, idx=4, status=LeadStatus.NEW, needs_review=False)  # обычная сирота

    ids = set(needs_review_leads().values_list("id", flat=True))
    assert len(ids) == 2


# ---------- Сервис rescue_stranded_leads_for_operator ---------------------


@pytest.mark.django_db
def test_service_moves_untouched_to_null_operator():
    inactive = _mk_op("Inactive4")
    lead = _mk_lead(inactive, idx=1, status=LeadStatus.NEW)

    result = rescue_stranded_leads_for_operator(operator=inactive)

    assert result["untouched_moved_to_pool"] == 1
    assert result["touched_moved_to_needs_review"] == 0

    lead.refresh_from_db()
    assert lead.operator_id is None
    assert lead.needs_review is False
    # Статус не трогаем (в untouched это new/assigned — сами по себе ok).
    assert lead.status in (LeadStatus.NEW, LeadStatus.ASSIGNED)

    # Старый LeadAssignment.active=False, новый — operator=NULL, active=True.
    assigns = list(lead.assignments.order_by("id"))
    assert len(assigns) == 2
    assert assigns[0].active is False
    assert assigns[1].active is True
    assert assigns[1].operator_id is None
    assert assigns[1].source == LeadAssignmentSource.SHEET_MANUAL
    assert "rescued" in assigns[1].reason


@pytest.mark.django_db
def test_service_moves_touched_to_needs_review_preserving_status():
    inactive = _mk_op("Inactive5")
    lead = _mk_lead(inactive, idx=1, status=LeadStatus.IN_PROGRESS)

    result = rescue_stranded_leads_for_operator(operator=inactive)

    assert result["untouched_moved_to_pool"] == 0
    assert result["touched_moved_to_needs_review"] == 1

    lead.refresh_from_db()
    assert lead.operator_id is None
    assert lead.needs_review is True
    assert lead.status == LeadStatus.IN_PROGRESS  # СТАТУС СОХРАНЁН


@pytest.mark.django_db
def test_service_does_not_touch_terminal():
    inactive = _mk_op("Inactive6")
    won = _mk_lead(inactive, idx=1, status=LeadStatus.WON)
    lost = _mk_lead(inactive, idx=2, status=LeadStatus.LOST)
    archived = _mk_lead(inactive, idx=3, status=LeadStatus.ARCHIVED)

    result = rescue_stranded_leads_for_operator(operator=inactive)

    assert result["untouched_moved_to_pool"] == 0
    assert result["touched_moved_to_needs_review"] == 0

    for lead in (won, lost, archived):
        lead.refresh_from_db()
        assert lead.operator_id == inactive.id


@pytest.mark.django_db
def test_service_is_idempotent():
    inactive = _mk_op("Inactive7")
    _mk_lead(inactive, idx=1, status=LeadStatus.NEW)
    _mk_lead(inactive, idx=2, status=LeadStatus.IN_PROGRESS)

    first = rescue_stranded_leads_for_operator(operator=inactive)
    second = rescue_stranded_leads_for_operator(operator=inactive)

    assert first == {"untouched_moved_to_pool": 1, "touched_moved_to_needs_review": 1}
    # Второй прогон — уже пусто (у оператора не осталось non-terminal лидов).
    assert second == {"untouched_moved_to_pool": 0, "touched_moved_to_needs_review": 0}


@pytest.mark.django_db
def test_service_writes_audit_log():
    inactive = _mk_op("Inactive8")
    _mk_lead(inactive, idx=1, status=LeadStatus.NEW)

    rescue_stranded_leads_for_operator(operator=inactive)

    entry = (
        AuditLog.objects.filter(
            entity="operators.Operator", entity_id=inactive.id
        )
        .order_by("-created_at")
        .first()
    )
    assert entry is not None
    assert entry.action == AuditAction.UPDATE
    assert "rescue_stranded_leads" in entry.changes


# ---------- Management-команда rescue_stranded_leads ---------------------


@pytest.mark.django_db
def test_command_dry_run_does_not_mutate():
    inactive = _mk_op("Inactive9")
    lead_a = _mk_lead(inactive, idx=1, status=LeadStatus.NEW)
    lead_b = _mk_lead(inactive, idx=2, status=LeadStatus.IN_PROGRESS)

    out = StringIO()
    call_command("rescue_stranded_leads", "--dry-run", stdout=out)
    output = out.getvalue()

    # Цифры в выводе.
    assert "untouched=1" in output
    assert "touched non-terminal=1" in output
    assert "would move" in output

    # БД не изменилась.
    lead_a.refresh_from_db()
    lead_b.refresh_from_db()
    assert lead_a.operator_id == inactive.id
    assert lead_b.operator_id == inactive.id
    assert lead_b.needs_review is False


@pytest.mark.django_db
def test_command_apply_moves_everything():
    inactive = _mk_op("InactiveA")
    lead_a = _mk_lead(inactive, idx=1, status=LeadStatus.NEW)
    lead_b = _mk_lead(inactive, idx=2, status=LeadStatus.IN_PROGRESS)

    out = StringIO()
    call_command("rescue_stranded_leads", stdout=out)
    output = out.getvalue()

    assert "moved" in output

    lead_a.refresh_from_db()
    lead_b.refresh_from_db()
    assert lead_a.operator_id is None
    assert lead_a.needs_review is False
    assert lead_b.operator_id is None
    assert lead_b.needs_review is True


@pytest.mark.django_db
def test_command_and_service_produce_same_counts():
    """
    dry-run должен возвращать те же цифры, что и apply. Ключевое
    свойство идемпотентной data-migration.
    """
    inactive = _mk_op("InactiveB")
    _mk_lead(inactive, idx=1, status=LeadStatus.NEW)
    _mk_lead(inactive, idx=2, status=LeadStatus.NEW)
    _mk_lead(inactive, idx=3, status=LeadStatus.IN_PROGRESS)
    _mk_lead(inactive, idx=4, status=LeadStatus.NO_ANSWER)

    dry_out = StringIO()
    call_command("rescue_stranded_leads", "--dry-run", stdout=dry_out)
    dry_output = dry_out.getvalue()

    apply_out = StringIO()
    call_command("rescue_stranded_leads", stdout=apply_out)
    apply_output = apply_out.getvalue()

    # Обе строки должны содержать одинаковые untouched/touched цифры.
    assert "untouched=2" in dry_output and "untouched=2" in apply_output
    assert "touched non-terminal=2" in dry_output
    assert "touched non-terminal=2" in apply_output

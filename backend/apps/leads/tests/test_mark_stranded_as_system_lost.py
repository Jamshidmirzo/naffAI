"""
Тесты для новой массовой миграции «пропавших лидов» → system-lost.

Три уровня:
  * `lead_mark_system_lost` (service, единичный лид, идемпотентен).
  * `lead_recover_from_system_lost` (обратная операция, чистит metadata).
  * `mark_stranded_as_system_lost` (management-команда: dry-run/apply,
    only-a/only-b, csv-snapshot).
"""

from __future__ import annotations

import csv
import json
from io import StringIO
from pathlib import Path

import pytest
from django.core.management import call_command

from apps.audit.models import AuditAction, AuditLog
from apps.common.exceptions import ApplicationError
from apps.leads.models import Lead, LeadAssignment, LeadStatus
from apps.leads.selectors import (
    exclude_system_lost,
    system_lost_leads_qs,
    system_lost_summary,
)
from apps.leads.services import (
    LOST_REASON_INVALID_PHONE_FROM_SHEET,
    LOST_REASON_STRANDED_ON_INACTIVE,
    lead_mark_system_lost,
    lead_recover_from_system_lost,
)
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
    if operator is not None:
        LeadAssignment.objects.create(
            lead=lead, operator=operator, source="admin_reassign", active=True
        )
    return lead


# ---------- lead_mark_system_lost -----------------------------------------


@pytest.mark.django_db
def test_mark_stranded_writes_full_metadata_and_flips_status():
    op = _mk_op("MaftunaX")
    lead = _mk_lead(op, idx=1, status=LeadStatus.IN_PROGRESS)

    result = lead_mark_system_lost(
        lead=lead,
        reason=LOST_REASON_STRANDED_ON_INACTIVE,
        comment="26 дней тишины после увольнения",
        original_operator_name="MaftunaX",
        original_status=LeadStatus.IN_PROGRESS,
    )

    assert result.status == LeadStatus.LOST
    assert result.operator_id is None
    md = result.metadata
    assert md["lost_reason"] == LOST_REASON_STRANDED_ON_INACTIVE
    assert md["lost_original_operator_name"] == "MaftunaX"
    assert md["lost_original_status"] == LeadStatus.IN_PROGRESS
    assert "lost_at" in md
    assert md["lost_by"].startswith("system:")
    assert "тишины" in md["lost_comment"]


@pytest.mark.django_db
def test_mark_is_idempotent_and_preserves_first_metadata():
    op = _mk_op("Kamron")
    lead = _mk_lead(op, idx=2, status=LeadStatus.NO_ANSWER)

    lead_mark_system_lost(
        lead=lead,
        reason=LOST_REASON_STRANDED_ON_INACTIVE,
        comment="first",
        original_operator_name="Kamron",
    )
    lead.refresh_from_db()
    first_at = lead.metadata["lost_at"]

    # Второй прогон — no-op, metadata остаётся как была.
    lead_mark_system_lost(
        lead=lead,
        reason=LOST_REASON_STRANDED_ON_INACTIVE,
        comment="second — should not overwrite",
        original_operator_name="Kamron",
    )
    lead.refresh_from_db()
    assert lead.metadata["lost_at"] == first_at
    assert lead.metadata["lost_comment"] == "first"


@pytest.mark.django_db
def test_mark_rejects_unknown_reason():
    op = _mk_op("Op")
    lead = _mk_lead(op, idx=3, status=LeadStatus.NEW)

    with pytest.raises(ApplicationError):
        lead_mark_system_lost(lead=lead, reason="unknown_bogus")


@pytest.mark.django_db
def test_mark_creates_audit_and_assignment():
    op = _mk_op("Bonu")
    lead = _mk_lead(op, idx=4, status=LeadStatus.HAS_DEBT)

    lead_mark_system_lost(
        lead=lead,
        reason=LOST_REASON_STRANDED_ON_INACTIVE,
        comment="test",
    )

    # Audit-запись есть.
    entry = (
        AuditLog.objects.filter(entity="leads.Lead", entity_id=str(lead.id))
        .order_by("-created_at")
        .first()
    )
    assert entry is not None
    assert entry.action == AuditAction.UPDATE
    assert entry.changes.get("system_lost") is True
    assert entry.changes["lost_reason"] == LOST_REASON_STRANDED_ON_INACTIVE

    # Старый assignment закрыт, новый operator=NULL.
    assigns = list(lead.assignments.order_by("id"))
    assert assigns[0].active is False
    assert assigns[-1].active is True
    assert assigns[-1].operator_id is None
    assert "system-lost" in assigns[-1].reason


# ---------- lead_recover_from_system_lost ---------------------------------


@pytest.mark.django_db
def test_recover_restores_status_and_clears_metadata():
    op = _mk_op("Munisa")
    lead = _mk_lead(op, idx=5, status=LeadStatus.IN_PROGRESS)

    lead_mark_system_lost(
        lead=lead,
        reason=LOST_REASON_STRANDED_ON_INACTIVE,
        comment="tmp",
        original_operator_name="Munisa",
    )
    lead.refresh_from_db()
    assert lead.status == LeadStatus.LOST

    recovered = lead_recover_from_system_lost(lead=lead)
    recovered.refresh_from_db()

    assert recovered.status == LeadStatus.IN_PROGRESS  # оригинал восстановлен
    assert recovered.operator_id is None  # → orphan пул
    # Все lost_* ключи очищены.
    for k in list(recovered.metadata.keys()):
        assert not k.startswith("lost_"), f"stale metadata key: {k}"


@pytest.mark.django_db
def test_recover_noop_on_non_system_lost_lead():
    op = _mk_op("Kamron2", status=OperatorStatus.ACTIVE)
    lead = _mk_lead(op, idx=6, status=LeadStatus.LOST)  # реальный отказ

    result = lead_recover_from_system_lost(lead=lead)
    result.refresh_from_db()
    assert result.status == LeadStatus.LOST
    assert result.operator_id == op.id  # НЕ отвязан


# ---------- exclude_system_lost + system_lost_leads_qs / summary ---------


@pytest.mark.django_db
def test_exclude_system_lost_filters_only_marked_leads():
    op = _mk_op("Op", status=OperatorStatus.ACTIVE)
    real_lost = _mk_lead(op, idx=7, status=LeadStatus.LOST)  # реальный
    stranded_lead = _mk_lead(op, idx=8, status=LeadStatus.IN_PROGRESS)
    lead_mark_system_lost(
        lead=stranded_lead,
        reason=LOST_REASON_STRANDED_ON_INACTIVE,
        comment="",
    )

    qs = Lead.objects.all()
    ids_visible = set(exclude_system_lost(qs).values_list("id", flat=True))
    assert real_lost.id in ids_visible
    assert stranded_lead.id not in ids_visible


@pytest.mark.django_db
def test_system_lost_qs_reason_and_op_filter():
    op = _mk_op("Raximjon")
    l1 = _mk_lead(op, idx=9, status=LeadStatus.IN_PROGRESS)
    l2 = _mk_lead(None, idx=10, status=LeadStatus.NEEDS_REVIEW, needs_review=True)

    lead_mark_system_lost(
        lead=l1,
        reason=LOST_REASON_STRANDED_ON_INACTIVE,
        original_operator_name="Raximjon",
    )
    lead_mark_system_lost(
        lead=l2,
        reason=LOST_REASON_INVALID_PHONE_FROM_SHEET,
    )

    # По reason
    stranded_ids = set(
        system_lost_leads_qs(reason=LOST_REASON_STRANDED_ON_INACTIVE)
        .values_list("id", flat=True)
    )
    assert stranded_ids == {l1.id}

    # По имени оператора
    by_op = set(
        system_lost_leads_qs(original_operator_name="Raximjon")
        .values_list("id", flat=True)
    )
    assert by_op == {l1.id}


@pytest.mark.django_db
def test_system_lost_summary_counts_by_reason_and_operator():
    op = _mk_op("Bonu2")
    for i in range(3):
        lead = _mk_lead(op, idx=100 + i, status=LeadStatus.IN_PROGRESS)
        lead_mark_system_lost(
            lead=lead,
            reason=LOST_REASON_STRANDED_ON_INACTIVE,
            original_operator_name="Bonu2",
        )

    lead = _mk_lead(None, idx=200, needs_review=True)
    lead_mark_system_lost(
        lead=lead, reason=LOST_REASON_INVALID_PHONE_FROM_SHEET
    )

    summary = system_lost_summary()
    assert summary["total"] == 4
    assert summary["by_reason"][LOST_REASON_STRANDED_ON_INACTIVE] == 3
    assert summary["by_reason"][LOST_REASON_INVALID_PHONE_FROM_SHEET] == 1
    assert summary["top_original_operators"] == [
        {"name": "Bonu2", "count": 3}
    ]


# ---------- management-команда mark_stranded_as_system_lost --------------


@pytest.mark.django_db
def test_command_dry_run_default_does_not_mutate():
    inactive = _mk_op("InactiveA")
    lead_touched = _mk_lead(inactive, idx=300, status=LeadStatus.IN_PROGRESS)
    lead_review = _mk_lead(
        None, idx=301, status=LeadStatus.NEEDS_REVIEW, needs_review=True
    )

    out = StringIO()
    call_command("mark_stranded_as_system_lost", stdout=out)
    output = out.getvalue()

    # Цифры в выводе — обе группы.
    assert "Group A (needs_review orphans): 1" in output
    assert "Group B (stranded on inactive): 1" in output
    assert "dry-run" in output

    # БД не изменилась.
    lead_touched.refresh_from_db()
    lead_review.refresh_from_db()
    assert lead_touched.status == LeadStatus.IN_PROGRESS
    assert lead_review.status == LeadStatus.NEEDS_REVIEW
    assert (lead_touched.metadata or {}).get("lost_reason") is None


@pytest.mark.django_db
def test_command_apply_marks_both_groups():
    inactive = _mk_op("InactiveB")
    lead_touched = _mk_lead(inactive, idx=400, status=LeadStatus.NO_ANSWER)
    lead_review = _mk_lead(
        None, idx=401, status=LeadStatus.NEEDS_REVIEW, needs_review=True
    )

    out = StringIO()
    call_command("mark_stranded_as_system_lost", "--apply", stdout=out)
    output = out.getvalue()

    assert "DONE" in output
    assert "A=1" in output and "B=1" in output

    lead_touched.refresh_from_db()
    lead_review.refresh_from_db()
    assert lead_touched.status == LeadStatus.LOST
    assert (
        lead_touched.metadata["lost_reason"]
        == LOST_REASON_STRANDED_ON_INACTIVE
    )
    assert lead_review.status == LeadStatus.LOST
    assert (
        lead_review.metadata["lost_reason"]
        == LOST_REASON_INVALID_PHONE_FROM_SHEET
    )


@pytest.mark.django_db
def test_command_apply_is_idempotent():
    inactive = _mk_op("InactiveC")
    _mk_lead(inactive, idx=500, status=LeadStatus.IN_PROGRESS)
    _mk_lead(None, idx=501, needs_review=True, status=LeadStatus.NEEDS_REVIEW)

    call_command("mark_stranded_as_system_lost", "--apply", stdout=StringIO())

    # Второй прогон — ничего не должно поменяться (лиды уже помечены).
    out = StringIO()
    call_command("mark_stranded_as_system_lost", "--apply", stdout=out)
    output = out.getvalue()
    # Группа A — needs_review flag сброшен на прошлом прогоне, теперь пусто.
    assert "Group A (needs_review orphans): 0" in output
    # Группа B — operator=NULL, теперь пусто.
    assert "Group B (stranded on inactive): 0" in output


@pytest.mark.django_db
def test_command_only_a_skips_b():
    inactive = _mk_op("InactiveD")
    lead_touched = _mk_lead(inactive, idx=600, status=LeadStatus.IN_PROGRESS)
    lead_review = _mk_lead(
        None, idx=601, status=LeadStatus.NEEDS_REVIEW, needs_review=True
    )

    call_command(
        "mark_stranded_as_system_lost", "--apply", "--only-a", stdout=StringIO()
    )

    lead_touched.refresh_from_db()
    lead_review.refresh_from_db()
    # Только Group A применена.
    assert lead_review.status == LeadStatus.LOST
    assert lead_touched.status == LeadStatus.IN_PROGRESS


@pytest.mark.django_db
def test_command_only_b_skips_a():
    inactive = _mk_op("InactiveE")
    lead_touched = _mk_lead(inactive, idx=700, status=LeadStatus.PHONE_ON)
    lead_review = _mk_lead(
        None, idx=701, status=LeadStatus.NEEDS_REVIEW, needs_review=True
    )

    call_command(
        "mark_stranded_as_system_lost", "--apply", "--only-b", stdout=StringIO()
    )

    lead_touched.refresh_from_db()
    lead_review.refresh_from_db()
    assert lead_touched.status == LeadStatus.LOST
    assert lead_review.status == LeadStatus.NEEDS_REVIEW  # не тронут


@pytest.mark.django_db
def test_command_csv_snapshot_writes_before_state(tmp_path: Path):
    inactive = _mk_op("InactiveF")
    _mk_lead(inactive, idx=800, status=LeadStatus.IN_PROGRESS)
    _mk_lead(None, idx=801, status=LeadStatus.NEEDS_REVIEW, needs_review=True)

    csv_path = tmp_path / "snap.csv"
    call_command(
        "mark_stranded_as_system_lost",
        f"--csv-snapshot={csv_path}",
        stdout=StringIO(),
    )

    assert csv_path.exists()
    with csv_path.open() as fh:
        rows = list(csv.DictReader(fh))
    assert len(rows) == 2
    assert {row["status"] for row in rows} == {"in_progress", "needs_review"}
    # metadata_json — валидный JSON.
    for row in rows:
        json.loads(row["metadata_json"])

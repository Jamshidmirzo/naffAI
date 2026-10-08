"""
Durable Google Sheets writeback (2026-10-08).

Writeback used to run in a daemon thread inside the gunicorn worker; every
worker restart (timeout / OOM / max-requests) silently dropped in-flight
writes. Now callers enqueue `SheetWritebackJob` on commit and the
`process_sheet_writebacks` worker drains it with retries. These tests pin:

- enqueue happens only after commit (and not at all on rollback);
- the worker writes once per lead, closes jobs, retries with backoff and
  gives up after MAX_ATTEMPTS;
- `writeback_reconcile_sheets` enqueues only real drift on active sheets
  and never touches rows that no longer belong to the lead.
"""

from __future__ import annotations

from datetime import timedelta
from unittest.mock import MagicMock, patch

import pytest
from django.core.management import call_command
from django.db import transaction
from django.utils import timezone

from apps.leads.management.commands import process_sheet_writebacks as worker
from apps.leads.models import Lead, LeadStatus, SheetSource, SheetWritebackJob
from apps.leads.services import _schedule_writeback
from apps.operators.models import Operator, OperatorStatus


@pytest.fixture
def sheet(db) -> SheetSource:
    return SheetSource.objects.create(
        name="test-sheet",
        spreadsheet_id="dummy",
        gid=42,
        worksheet_name="Leads",
        active=True,
        writeback_columns={
            "enabled": True,
            "status_col": "D",
            "operator_col": "E",
            "updated_col": "F",
            "comment_col": "G",
        },
    )


def _lead(sheet, idx: int, **kw) -> Lead:
    defaults = dict(
        full_name=f"L-{idx}",
        phone=f"+99890{idx:07d}",
        status=LeadStatus.NEW,
        sheet_source=sheet,
        sheet_row_index=idx,
    )
    defaults.update(kw)
    return Lead.objects.create(**defaults)


# ---- enqueue -------------------------------------------------------------


@pytest.mark.django_db(transaction=True)
def test_job_enqueued_only_after_commit(sheet):
    """Which call sites schedule a writeback is pinned by
    test_writeback_on_assign; here — that the schedule turns into a
    durable job, and only once the transaction commits."""
    lead = _lead(sheet, 2)

    with transaction.atomic():
        _schedule_writeback(lead.id, comment="перезвонить")
        assert not SheetWritebackJob.objects.exists()

    job = SheetWritebackJob.objects.get(lead=lead)
    assert job.comment == "перезвонить"
    assert job.done_at is None


@pytest.mark.django_db(transaction=True)
def test_rollback_enqueues_nothing(sheet):
    lead = _lead(sheet, 3)

    with pytest.raises(RuntimeError), transaction.atomic():
        _schedule_writeback(lead.id, comment="x")
        raise RuntimeError("rollback")

    assert not SheetWritebackJob.objects.exists()


# ---- worker --------------------------------------------------------------


def _job(lead, **kw) -> SheetWritebackJob:
    return SheetWritebackJob.objects.create(lead=lead, next_try_at=timezone.now(), **kw)


@pytest.mark.django_db
def test_worker_writes_once_per_lead_and_closes_jobs(sheet):
    lead = _lead(sheet, 4, status=LeadStatus.NO_ANSWER)
    _job(lead, comment="")
    _job(lead, comment="перезвонить")

    with patch("apps.leads.services.lead_writeback_to_sheet") as wb:
        stats = worker.process_due_jobs(pause_s=0)

    assert stats["ok"] == 1
    assert wb.call_count == 1
    assert wb.call_args.kwargs == {"comment": "перезвонить", "raise_errors": True}
    assert not SheetWritebackJob.objects.filter(done_at__isnull=True).exists()


@pytest.mark.django_db
def test_worker_failure_schedules_retry(sheet):
    lead = _lead(sheet, 5, status=LeadStatus.NO_ANSWER)
    job = _job(lead)

    with patch("apps.leads.services.lead_writeback_to_sheet", side_effect=RuntimeError("429")):
        stats = worker.process_due_jobs(pause_s=0)

    job.refresh_from_db()
    assert stats["failed"] == 1
    assert job.attempts == 1
    assert job.done_at is None
    assert job.next_try_at > timezone.now() + timedelta(seconds=20)
    assert "429" in job.last_error


@pytest.mark.django_db
def test_worker_gives_up_after_max_attempts(sheet):
    lead = _lead(sheet, 6, status=LeadStatus.NO_ANSWER)
    job = _job(lead, attempts=worker.MAX_ATTEMPTS - 1)

    with patch("apps.leads.services.lead_writeback_to_sheet", side_effect=RuntimeError("boom")):
        stats = worker.process_due_jobs(pause_s=0)

    job.refresh_from_db()
    assert stats["gave_up"] == 1
    assert job.done_at is not None


@pytest.mark.django_db
def test_worker_skips_jobs_not_yet_due(sheet):
    lead = _lead(sheet, 7, status=LeadStatus.NO_ANSWER)
    SheetWritebackJob.objects.create(lead=lead, next_try_at=timezone.now() + timedelta(minutes=5))

    with patch("apps.leads.services.lead_writeback_to_sheet") as wb:
        stats = worker.process_due_jobs(pause_s=0)

    assert stats["leads"] == 0
    assert wb.call_count == 0


# ---- reconcile -----------------------------------------------------------


@pytest.mark.django_db
def test_reconcile_enqueues_only_real_drift(sheet):
    op = Operator.objects.create(full_name="Bob", status=OperatorStatus.ACTIVE)
    in_sync = _lead(sheet, 2, status=LeadStatus.NO_ANSWER, operator=op)
    drifted = _lead(sheet, 3, status=LeadStatus.NO_ANSWER, operator=op)
    moved = _lead(sheet, 4, status=LeadStatus.NO_ANSWER, operator=op)
    _lead(sheet, 5, status=LeadStatus.NEEDS_REVIEW, operator=op)
    _lead(sheet, 6, status=LeadStatus.NO_ANSWER)  # no operator yet

    rows = [
        ["product", "name", "phone", "status"],
        ["iPhone", "A", in_sync.phone, "no_answer"],
        ["iPhone", "B", drifted.phone, ""],
        ["iPhone", "C", "+998901112233", ""],  # row now belongs to someone else
        ["iPhone", "D", "+998900000005", ""],
        ["iPhone", "E", "+998900000006", ""],
    ]
    client = MagicMock()
    client.raw_values.return_value = rows
    with patch(
        "apps.leads.integrations.google_sheets.client.GoogleSheetsClient",
        return_value=client,
    ):
        call_command("writeback_reconcile_sheets", "--days", "1")

    assert set(SheetWritebackJob.objects.values_list("lead_id", flat=True)) == {drifted.id}
    assert not SheetWritebackJob.objects.filter(lead=moved).exists()


@pytest.mark.django_db
def test_reconcile_dry_run_enqueues_nothing(sheet):
    op = Operator.objects.create(full_name="Bob", status=OperatorStatus.ACTIVE)
    lead = _lead(sheet, 2, status=LeadStatus.NO_ANSWER, operator=op)
    client = MagicMock()
    client.raw_values.return_value = [["h"], ["x", "y", lead.phone, ""]]
    with patch(
        "apps.leads.integrations.google_sheets.client.GoogleSheetsClient",
        return_value=client,
    ):
        call_command("writeback_reconcile_sheets", "--dry-run")

    assert not SheetWritebackJob.objects.exists()

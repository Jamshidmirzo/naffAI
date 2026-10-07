"""
Writeback-on-assign (2026-10-07): when auto-distribution assigns a lead
to an operator, the operator's name must be reflected in Google Sheets
column E so the manager sees who owns the lead without touching anything.

Regression: before this fix, `lead_update_status` wrote back on manual
status changes, but `lead_auto_assign` / `morning_distribute_leads` /
`refill_operator_leads` only `bulk_update`'d the DB — the sheet stayed
empty until the operator touched the lead.

We patch `_writeback_async` / `_writeback_batch_async` at module level —
both are called from inside `transaction.on_commit` and are the exact
seam between "schedule a writeback" and "actually hit Google". Mocking
them avoids a) hitting Google, b) threading races in asserts.
"""

from __future__ import annotations

from unittest.mock import patch

import pytest

from apps.leads.models import (
    Lead,
    LeadStatus,
    SheetSource,
)
from apps.leads.services import (
    lead_auto_assign,
    morning_distribute_leads,
    refill_operator_leads,
)
from apps.operators.models import Operator, OperatorStatus


def _mk_sheet_lead(idx: int, sheet_source: SheetSource) -> Lead:
    """Create a lead that has (sheet_source, sheet_row_index) populated —
    writeback only fires for leads that came from a sheet."""
    return Lead.objects.create(
        full_name=f"L-{idx}",
        phone=f"+99890{idx:07d}",
        status=LeadStatus.NEW,
        operator=None,
        sheet_source=sheet_source,
        sheet_row_index=1000 + idx,
    )


@pytest.fixture
def active_sheet(db) -> SheetSource:
    return SheetSource.objects.create(
        name="test-sheet",
        spreadsheet_id="dummy",
        gid=42,
        active=True,
        writeback_columns={
            "enabled": True,
            "status_col": "D",
            "operator_col": "E",
            "updated_col": "F",
            "comment_col": "G",
        },
    )


# ---- lead_auto_assign ----------------------------------------------------


@pytest.mark.django_db(transaction=True, serialized_rollback=True)
def test_lead_auto_assign_schedules_writeback(active_sheet):
    """Одиночное авто-назначение → _writeback_async зашедулен для этого лида."""
    op = Operator.objects.create(full_name="Alice", status=OperatorStatus.ACTIVE)
    lead = _mk_sheet_lead(1, active_sheet)

    with patch(
        "apps.leads.services._writeback_async", autospec=True
    ) as mock_wb:
        lead_auto_assign(lead=lead)

    assert mock_wb.call_count == 1
    assert mock_wb.call_args.args[0] == lead.id


# ---- morning_distribute_leads -------------------------------------------


@pytest.mark.django_db(transaction=True, serialized_rollback=True)
def test_morning_distribute_schedules_batch_writeback(active_sheet):
    """Утренняя раздача → _writeback_batch_async вызван с id'шниками КАЖДОГО
    назначенного лида."""
    ops = [
        Operator.objects.create(full_name=f"OP-{i}", status=OperatorStatus.ACTIVE)
        for i in range(2)
    ]
    lead_ids = [_mk_sheet_lead(i, active_sheet).id for i in range(6)]

    with patch(
        "apps.leads.services._writeback_batch_async", autospec=True
    ) as mock_wb_batch:
        counts = morning_distribute_leads(seed=42)

    assert sum(counts.values()) == 6
    # Один batch-вызов на всю раздачу.
    assert mock_wb_batch.call_count == 1
    # Первый positional — список id'шников, равный множеству назначенных.
    passed_ids = mock_wb_batch.call_args.args[0]
    assigned_ids_in_db = set(
        Lead.objects.filter(operator__in=ops).values_list("id", flat=True)
    )
    assert set(passed_ids) == set(lead_ids) == assigned_ids_in_db


@pytest.mark.django_db(transaction=True, serialized_rollback=True)
def test_morning_distribute_empty_pool_no_writeback(active_sheet):
    """Пустой пул → batch-writeback не вызывается."""
    Operator.objects.create(full_name="OP", status=OperatorStatus.ACTIVE)

    with patch(
        "apps.leads.services._writeback_batch_async", autospec=True
    ) as mock_wb_batch:
        morning_distribute_leads(seed=42)

    assert mock_wb_batch.call_count == 0


# ---- refill_operator_leads ----------------------------------------------


@pytest.mark.django_db(transaction=True, serialized_rollback=True)
def test_refill_schedules_batch_writeback(active_sheet):
    """refill налил N лидов → batch-writeback зашедулен с id'шниками каждого."""
    op = Operator.objects.create(full_name="OP", status=OperatorStatus.ACTIVE)
    for i in range(10):
        _mk_sheet_lead(i, active_sheet)

    with patch(
        "apps.leads.services._writeback_batch_async", autospec=True
    ) as mock_wb_batch:
        assigned = refill_operator_leads(operator=op, size=5)

    assert len(assigned) == 5
    assert mock_wb_batch.call_count == 1
    passed_ids = mock_wb_batch.call_args.args[0]
    assert set(passed_ids) == {lead.id for lead in assigned}


@pytest.mark.django_db(transaction=True, serialized_rollback=True)
def test_refill_empty_pool_no_writeback(active_sheet):
    """refill ничего не нашёл → batch-writeback не вызывается."""
    op = Operator.objects.create(full_name="OP", status=OperatorStatus.ACTIVE)

    with patch(
        "apps.leads.services._writeback_batch_async", autospec=True
    ) as mock_wb_batch:
        refill_operator_leads(operator=op, size=5)

    assert mock_wb_batch.call_count == 0


# ---- control: existing path still works ---------------------------------


@pytest.mark.django_db(transaction=True, serialized_rollback=True)
def test_lead_update_status_still_schedules_writeback(active_sheet):
    """Контроль не-регрессии: ручная смена статуса оператором всё ещё шедулит
    writeback (это и так работало до фикса — пусть покроем явно)."""
    from apps.leads.services import lead_update_status

    op = Operator.objects.create(full_name="OP", status=OperatorStatus.ACTIVE)
    lead = Lead.objects.create(
        full_name="L", phone="+998900000000",
        status=LeadStatus.ASSIGNED, operator=op,
        sheet_source=active_sheet, sheet_row_index=100,
    )

    with patch(
        "apps.leads.services._writeback_async", autospec=True
    ) as mock_wb:
        lead_update_status(lead=lead, status=LeadStatus.WON, comment="продано")

    assert mock_wb.call_count >= 1


# ---- batch helper behavior ----------------------------------------------


@pytest.mark.django_db(transaction=True, serialized_rollback=True)
def test_schedule_writeback_batch_empty_list_is_noop():
    """Edge-case: пустой список не создаёт on_commit-хук."""
    from apps.leads.services import _schedule_writeback_batch

    with patch(
        "apps.leads.services._writeback_batch_async", autospec=True
    ) as mock_wb_batch:
        _schedule_writeback_batch([])

    assert mock_wb_batch.call_count == 0

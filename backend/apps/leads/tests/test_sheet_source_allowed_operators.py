"""
Per-sheet operator pool (`SheetSource.allowed_operators`, 2026-09-14).

Проверяем:
  T1 — пустой пул → next_operator_for_round_robin(sheet_source=src) работает
       как раньше (берёт из всех активных).
  T2 — заполненный пул → RR возвращает только op из пула.
  T3 — refill_operator_leads: оператор НЕ в пуле не получает лидов
       из «пулового» шита; оператор в пуле получает.
  T4 — sheet_source_upsert(allowed_operator_ids=[...]) сохраняет M2M;
       передача None — не трогает существующий пул.
  T5 — lead_create_from_sheet_row(alias_or_rr) уважает пул: сирота
       из pool-шита получает оператора из пула.
"""

from __future__ import annotations

import pytest

from apps.leads.models import (
    DistributionMode,
    Lead,
    LeadStatus,
    SheetSource,
)
from apps.leads.selectors import next_operator_for_round_robin
from apps.leads.services import (
    lead_create_from_sheet_row,
    refill_operator_leads,
    sheet_source_upsert,
)
from apps.operators.models import Operator, OperatorStatus


@pytest.fixture
def three_ops(db) -> tuple[Operator, Operator, Operator]:
    op1 = Operator.objects.create(full_name="Alice", status=OperatorStatus.ACTIVE)
    op2 = Operator.objects.create(full_name="Bob", status=OperatorStatus.ACTIVE)
    op3 = Operator.objects.create(full_name="Carol", status=OperatorStatus.ACTIVE)
    return op1, op2, op3


@pytest.fixture
def sheet_pool(db) -> SheetSource:
    return SheetSource.objects.create(
        name="Pool sheet",
        spreadsheet_id="SS_POOL",
        gid=100,
        column_map={"phone": "phone", "full_name": "name"},
        distribution_mode=DistributionMode.ALIAS_OR_ROUND_ROBIN,
    )


@pytest.fixture
def sheet_open(db) -> SheetSource:
    """Шит без per-sheet пула (allowed_operators пуст) — раздача всем."""
    return SheetSource.objects.create(
        name="Open sheet",
        spreadsheet_id="SS_OPEN",
        gid=200,
        column_map={"phone": "phone", "full_name": "name"},
        distribution_mode=DistributionMode.ALIAS_OR_ROUND_ROBIN,
    )


# ---- T1 -------------------------------------------------------------------


@pytest.mark.django_db
def test_rr_with_empty_pool_falls_back_to_all_active(three_ops, sheet_pool):
    op1, op2, op3 = three_ops
    # Пул пуст — sheet_source.allowed_operators.exists() == False.
    # Ожидаем: берётся из всех троих; при равной загрузке — минимальный id.
    picked = next_operator_for_round_robin(sheet_source=sheet_pool)
    assert picked is not None
    assert picked.id == op1.id


# ---- T2 -------------------------------------------------------------------


@pytest.mark.django_db
def test_rr_with_pool_restricts_to_pool_members(three_ops, sheet_pool):
    op1, op2, op3 = three_ops
    sheet_pool.allowed_operators.set([op2, op3])
    picked = next_operator_for_round_robin(sheet_source=sheet_pool)
    assert picked is not None
    assert picked.id in {op2.id, op3.id}
    # tie-break на min(id) → op2
    assert picked.id == op2.id


@pytest.mark.django_db
def test_rr_without_sheet_source_ignores_pools(three_ops, sheet_pool):
    """
    Callers, не передавшие sheet_source (например manual lead_auto_assign),
    получают исторический глобальный round-robin.
    """
    op1, op2, op3 = three_ops
    sheet_pool.allowed_operators.set([op3])
    picked = next_operator_for_round_robin()  # без sheet_source
    assert picked.id == op1.id


# ---- T3 -------------------------------------------------------------------


@pytest.mark.django_db(transaction=True, serialized_rollback=True)
def test_refill_respects_per_sheet_pool(three_ops, sheet_pool, sheet_open):
    op1, op2, op3 = three_ops
    # op1, op2 — в пуле шита sheet_pool. op3 — нет.
    sheet_pool.allowed_operators.set([op1, op2])

    # 3 сироты из pool-шита, 2 сироты из open-шита.
    for i in range(3):
        Lead.objects.create(
            full_name=f"pool-{i}",
            phone=f"+99890000{i:04d}",
            status=LeadStatus.NEW,
            sheet_source=sheet_pool,
            sheet_row_index=100 + i,
        )
    for i in range(2):
        Lead.objects.create(
            full_name=f"open-{i}",
            phone=f"+99891000{i:04d}",
            status=LeadStatus.NEW,
            sheet_source=sheet_open,
            sheet_row_index=200 + i,
        )

    # op3 (не в пуле) — должен получить только 2 open-лидов, pool-лидов не касается.
    delivered_op3 = refill_operator_leads(operator=op3, size=10)
    assert len(delivered_op3) == 2
    for lead in delivered_op3:
        assert lead.sheet_source_id == sheet_open.id

    # op1 (в пуле) — оставшихся 3 pool-лидов должен забрать.
    delivered_op1 = refill_operator_leads(operator=op1, size=10)
    assert len(delivered_op1) == 3
    for lead in delivered_op1:
        assert lead.sheet_source_id == sheet_pool.id


@pytest.mark.django_db(transaction=True, serialized_rollback=True)
def test_refill_backward_compat_when_all_sheets_open(three_ops, sheet_open):
    """
    Обратная совместимость: если ни у одного шита не задан пул, refill
    берёт всех сирот подряд (историческое поведение).
    """
    op1, op2, op3 = three_ops
    for i in range(5):
        Lead.objects.create(
            full_name=f"open-{i}",
            phone=f"+99891000{i:04d}",
            status=LeadStatus.NEW,
            sheet_source=sheet_open,
            sheet_row_index=200 + i,
        )
    delivered = refill_operator_leads(operator=op3, size=5)
    assert len(delivered) == 5


# ---- T4 -------------------------------------------------------------------


@pytest.mark.django_db
def test_sheet_source_upsert_saves_allowed_operator_ids(three_ops):
    op1, op2, op3 = three_ops
    obj = sheet_source_upsert(
        name="X",
        spreadsheet_id="SS_X",
        gid=1,
        column_map={"phone": "phone", "full_name": "name"},
        allowed_operator_ids=[op1.id, op2.id],
    )
    assert set(obj.allowed_operators.values_list("id", flat=True)) == {op1.id, op2.id}

    # Повторный upsert без параметра — пул НЕ трогается (backward compat).
    sheet_source_upsert(
        name="X-renamed",
        spreadsheet_id="SS_X",
        gid=1,
        column_map={"phone": "phone", "full_name": "name"},
    )
    obj.refresh_from_db()
    assert set(obj.allowed_operators.values_list("id", flat=True)) == {op1.id, op2.id}

    # Пустой список — очищает пул.
    sheet_source_upsert(
        name="X-cleared",
        spreadsheet_id="SS_X",
        gid=1,
        column_map={"phone": "phone", "full_name": "name"},
        allowed_operator_ids=[],
    )
    obj.refresh_from_db()
    assert obj.allowed_operators.count() == 0


# ---- T5 -------------------------------------------------------------------


@pytest.mark.django_db(transaction=True, serialized_rollback=True)
def test_alias_or_rr_sync_respects_pool(three_ops, sheet_pool):
    """
    lead_create_from_sheet_row в режиме alias_or_rr должен пересечь
    round-robin с per-sheet пулом.
    """
    op1, op2, op3 = three_ops
    # Пул = только op3. Значит новый лид должен упасть на op3, а не op1.
    sheet_pool.allowed_operators.set([op3])

    row = {
        "phone_number": "+998900000001",
        "phone": "+998900000001",
        "full_name": "Test Client",
        "name": "Test Client",
    }
    # column_map у sheet_pool = {"phone": "phone", "full_name": "name"}.
    lead, action = lead_create_from_sheet_row(
        sheet_source=sheet_pool,
        row_index=1,
        raw_row=row,
    )
    assert action == "created"
    assert lead.operator_id == op3.id

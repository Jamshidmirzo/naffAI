"""
Watcher `refill_idle_operators`: раз в минуту доливает сирот
активным операторам с working_count=0. Тесты:
- idle оператор + пул → получил пачку
- busy оператор → пропущен
- inactive оператор → пропущен
- killswitch (SystemSetting.auto_distribution_enabled=False) → 0 всем
"""

from __future__ import annotations

from io import StringIO

import pytest
from django.core.management import call_command

from apps.leads.models import Lead, LeadAssignment, LeadAssignmentSource, LeadStatus
from apps.operators.models import Operator, OperatorStatus
from apps.system_settings.models import SystemSetting


def _mk_orphan(idx: int) -> Lead:
    return Lead.objects.create(
        full_name=f"P-{idx}",
        phone=f"+99890{idx:07d}",
        status=LeadStatus.NEW,
        operator=None,
    )


def _mk_lead_assigned(op: Operator, idx: int) -> Lead:
    return Lead.objects.create(
        full_name=f"A-{idx}",
        phone=f"+99899{idx:07d}",
        status=LeadStatus.ASSIGNED,
        operator=op,
    )


@pytest.mark.django_db
def test_refill_watcher_delivers_to_idle_operator():
    """idle оператор с 0 активных + 10 сирот → получил 5."""
    op = Operator.objects.create(full_name="OP", status=OperatorStatus.ACTIVE)
    for i in range(10):
        _mk_orphan(i)

    out = StringIO()
    call_command("refill_idle_operators", stdout=out)

    assert Lead.objects.filter(operator=op).count() == 5
    assert LeadAssignment.objects.filter(
        operator=op, source=LeadAssignmentSource.AUTO_REFILL
    ).count() == 5


@pytest.mark.django_db
def test_refill_watcher_skips_busy_operator():
    """У оператора working_count=3 → пропускаем, не назначаем ничего."""
    op = Operator.objects.create(full_name="OP", status=OperatorStatus.ACTIVE)
    for i in range(3):
        _mk_lead_assigned(op, i)
    for i in range(10):
        _mk_orphan(i + 100)

    call_command("refill_idle_operators")

    # У оператора по-прежнему только 3 своих (никаких новых).
    assert Lead.objects.filter(operator=op).count() == 3
    assert LeadAssignment.objects.filter(
        operator=op, source=LeadAssignmentSource.AUTO_REFILL
    ).count() == 0


@pytest.mark.django_db
def test_refill_watcher_skips_inactive_operator():
    """Оператор INACTIVE не участвует в проходе даже если пул полный."""
    inactive = Operator.objects.create(
        full_name="Sleepy", status=OperatorStatus.INACTIVE
    )
    for i in range(10):
        _mk_orphan(i)

    call_command("refill_idle_operators")

    assert Lead.objects.filter(operator=inactive).count() == 0
    assert LeadAssignment.objects.filter(
        source=LeadAssignmentSource.AUTO_REFILL
    ).count() == 0


@pytest.mark.django_db
def test_refill_watcher_respects_kill_switch():
    """auto_distribution_enabled=False → команда ничего не делает."""
    op = Operator.objects.create(full_name="OP", status=OperatorStatus.ACTIVE)
    for i in range(10):
        _mk_orphan(i)

    setting = SystemSetting.get_solo()
    setting.auto_distribution_enabled = False
    setting.save(update_fields=["auto_distribution_enabled", "updated_at"])

    out = StringIO()
    call_command("refill_idle_operators", stdout=out)

    assert "disabled" in out.getvalue()
    assert Lead.objects.filter(operator=op).count() == 0
    assert LeadAssignment.objects.filter(
        source=LeadAssignmentSource.AUTO_REFILL
    ).count() == 0


@pytest.mark.django_db
def test_refill_watcher_handles_multiple_operators():
    """Два idle + один busy → idle-двое получают, busy — нет."""
    op1 = Operator.objects.create(full_name="OP1", status=OperatorStatus.ACTIVE)
    op2 = Operator.objects.create(full_name="OP2", status=OperatorStatus.ACTIVE)
    op3 = Operator.objects.create(full_name="OP3-busy", status=OperatorStatus.ACTIVE)
    _mk_lead_assigned(op3, 999)

    for i in range(20):
        _mk_orphan(i)

    call_command("refill_idle_operators")

    # op1, op2 — по 5. op3 — только своя старая.
    assert Lead.objects.filter(operator=op1).count() == 5
    assert Lead.objects.filter(operator=op2).count() == 5
    assert Lead.objects.filter(operator=op3).count() == 1


@pytest.mark.django_db
def test_refill_watcher_limit_option():
    """--limit N обрабатывает только N операторов."""
    ops = [
        Operator.objects.create(full_name=f"OP{i}", status=OperatorStatus.ACTIVE)
        for i in range(3)
    ]
    for i in range(30):
        _mk_orphan(i)

    call_command("refill_idle_operators", limit=2)

    # Первые двое (по id) получили. Третий — нет.
    assert Lead.objects.filter(operator=ops[0]).count() == 5
    assert Lead.objects.filter(operator=ops[1]).count() == 5
    assert Lead.objects.filter(operator=ops[2]).count() == 0

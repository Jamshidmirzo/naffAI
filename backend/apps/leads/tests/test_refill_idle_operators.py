"""
Watcher `refill_idle_operators` (continuous-mode): раз в минуту
проходит по активным операторам и доливает КАЖДОМУ до
RR_BATCH_SIZE = 5. Тесты:
- idle оператор + пул → получил полную пачку (5)
- частично загруженный (working<5) → доливает недостающее
- на квоте (working>=5) → пропущен
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
def test_refill_watcher_tops_up_partially_loaded_operator():
    """
    working=3, target=5, need=2 → доливает 2 из пула. Continuous-mode:
    старая логика «skip если working>0» больше не действует.
    """
    op = Operator.objects.create(full_name="OP", status=OperatorStatus.ACTIVE)
    for i in range(3):
        _mk_lead_assigned(op, i)
    for i in range(10):
        _mk_orphan(i + 100)

    call_command("refill_idle_operators")

    assert Lead.objects.filter(operator=op).count() == 5
    assert LeadAssignment.objects.filter(
        operator=op, source=LeadAssignmentSource.AUTO_REFILL
    ).count() == 2


@pytest.mark.django_db
def test_refill_watcher_skips_operator_at_or_over_target():
    """working==5 → need=0, пропускаем."""
    op = Operator.objects.create(full_name="OP", status=OperatorStatus.ACTIVE)
    for i in range(5):
        _mk_lead_assigned(op, i)
    for i in range(10):
        _mk_orphan(i + 100)

    call_command("refill_idle_operators")

    assert Lead.objects.filter(operator=op).count() == 5
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
    """
    Два idle + один частично загруженный → все дополняются до 5.
    - op1: idle → +5 → total 5
    - op2: idle → +5 → total 5
    - op3: 1 старый + 4 refill → total 5
    В пуле 20 сирот, всего раздано 14 → должно хватить.
    """
    op1 = Operator.objects.create(full_name="OP1", status=OperatorStatus.ACTIVE)
    op2 = Operator.objects.create(full_name="OP2", status=OperatorStatus.ACTIVE)
    op3 = Operator.objects.create(full_name="OP3-partial", status=OperatorStatus.ACTIVE)
    _mk_lead_assigned(op3, 999)

    for i in range(20):
        _mk_orphan(i)

    call_command("refill_idle_operators")

    assert Lead.objects.filter(operator=op1).count() == 5
    assert Lead.objects.filter(operator=op2).count() == 5
    assert Lead.objects.filter(operator=op3).count() == 5


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

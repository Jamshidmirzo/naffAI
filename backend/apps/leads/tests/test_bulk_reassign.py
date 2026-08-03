"""
Bulk-reassign: массовое переназначение сирот менеджером.
- operator_id → все на этого оператора
- mode=round_robin → распределено ~поровну
- mixed (сирота + уже-назначенный) → 400 + список невалидных lead_ids
- Только менеджер
"""

from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from apps.audit.models import AuditLog
from apps.leads.models import Lead, LeadAssignment, LeadAssignmentSource, LeadStatus
from apps.leads.services import leads_bulk_reassign
from apps.operators.models import Operator, OperatorStatus
from apps.users.models import Profile, Role

User = get_user_model()


def _orphan(idx: int) -> Lead:
    return Lead.objects.create(
        full_name=f"O-{idx}",
        phone=f"+99890{idx:07d}",
        status=LeadStatus.NEW,
        operator=None,
    )


def _mgr():
    user = User.objects.create_user(username="mgr", password="mgrpass1")
    Profile.objects.create(user=user, role=Role.MANAGER)
    return user


def _op():
    user = User.objects.create_user(username="op", password="oppass123")
    operator = Operator.objects.create(full_name="Op", status=OperatorStatus.ACTIVE)
    Profile.objects.create(user=user, role=Role.OPERATOR, operator=operator)
    return user


@pytest.mark.django_db
def test_bulk_reassign_by_operator_id_service_level():
    op = Operator.objects.create(full_name="OP", status=OperatorStatus.ACTIVE)
    leads = [_orphan(i) for i in range(5)]

    user = _mgr()
    result = leads_bulk_reassign(
        lead_ids=[ld.id for ld in leads],
        operator_id=op.id,
        user=user,
    )

    assert result["total"] == 5
    assert result["assigned"] == {str(op.id): 5}
    for ld in leads:
        ld.refresh_from_db()
        assert ld.operator_id == op.id
        assert ld.status == LeadStatus.ASSIGNED
    assert LeadAssignment.objects.filter(
        operator=op, source=LeadAssignmentSource.ADMIN_REASSIGN
    ).count() == 5

    entry = (
        AuditLog.objects.filter(entity="leads.Lead")
        .order_by("-created_at")
        .first()
    )
    assert entry is not None
    assert entry.user_id == user.id
    assert "bulk_reassign" in entry.changes


@pytest.mark.django_db
def test_bulk_reassign_round_robin_distributes_evenly():
    op1 = Operator.objects.create(full_name="OP1", status=OperatorStatus.ACTIVE)
    op2 = Operator.objects.create(full_name="OP2", status=OperatorStatus.ACTIVE)
    op3 = Operator.objects.create(full_name="OP3", status=OperatorStatus.ACTIVE)
    leads = [_orphan(i) for i in range(9)]

    result = leads_bulk_reassign(
        lead_ids=[ld.id for ld in leads],
        mode="round_robin",
        user=_mgr(),
    )

    # 9 / 3 = 3 каждому (порядок операторов рандомизирован, но total == 9).
    assert result["total"] == 9
    counts = list(result["assigned"].values())
    assert sorted(counts) == [3, 3, 3]

    ops_by_id = {op1.id: op1, op2.id: op2, op3.id: op3}
    for ld in leads:
        ld.refresh_from_db()
        assert ld.operator_id in ops_by_id


@pytest.mark.django_db
def test_bulk_reassign_rejects_already_assigned():
    op = Operator.objects.create(full_name="OP", status=OperatorStatus.ACTIVE)
    other = Operator.objects.create(full_name="OTHER", status=OperatorStatus.ACTIVE)
    orphan = _orphan(1)
    already = Lead.objects.create(
        full_name="already",
        phone="+998999999999",
        status=LeadStatus.ASSIGNED,
        operator=other,
    )

    from apps.common.exceptions import ApplicationError

    with pytest.raises(ApplicationError) as ei:
        leads_bulk_reassign(
            lead_ids=[orphan.id, already.id],
            operator_id=op.id,
            user=_mgr(),
        )
    extra = ei.value.extra
    assert already.id in extra["already_assigned_ids"]

    # Ни один из лидов не должен был переехать (транзакция откатилась).
    orphan.refresh_from_db()
    already.refresh_from_db()
    assert orphan.operator_id is None
    assert already.operator_id == other.id


@pytest.mark.django_db
def test_bulk_reassign_rejects_missing_ids():
    op = Operator.objects.create(full_name="OP", status=OperatorStatus.ACTIVE)
    orphan = _orphan(1)
    missing_id = orphan.id + 999

    from apps.common.exceptions import ApplicationError

    with pytest.raises(ApplicationError) as ei:
        leads_bulk_reassign(
            lead_ids=[orphan.id, missing_id],
            operator_id=op.id,
            user=_mgr(),
        )
    assert missing_id in ei.value.extra["missing_ids"]


@pytest.mark.django_db
def test_bulk_reassign_rejects_inactive_operator():
    inactive = Operator.objects.create(full_name="SLP", status=OperatorStatus.INACTIVE)
    orphan = _orphan(1)

    from apps.common.exceptions import ApplicationError

    with pytest.raises(ApplicationError) as ei:
        leads_bulk_reassign(
            lead_ids=[orphan.id],
            operator_id=inactive.id,
            user=_mgr(),
        )
    assert "operator_status" in ei.value.extra


@pytest.mark.django_db
def test_bulk_reassign_api_manager_only():
    Operator.objects.create(full_name="OP", status=OperatorStatus.ACTIVE)
    orphan = _orphan(1)

    op_user = _op()
    c = APIClient()
    c.force_authenticate(user=op_user)

    r = c.post(
        "/api/leads/bulk-reassign/",
        {"lead_ids": [orphan.id], "operator_id": op_user.profile.operator_id},
        format="json",
    )
    assert r.status_code == 403


@pytest.mark.django_db
def test_bulk_reassign_api_happy_path():
    op = Operator.objects.create(full_name="OP", status=OperatorStatus.ACTIVE)
    leads = [_orphan(i) for i in range(3)]

    mgr = _mgr()
    c = APIClient()
    c.force_authenticate(user=mgr)

    r = c.post(
        "/api/leads/bulk-reassign/",
        {"lead_ids": [ld.id for ld in leads], "operator_id": op.id},
        format="json",
    )
    assert r.status_code == 200, r.content
    assert r.data["total"] == 3
    assert r.data["assigned"] == {str(op.id): 3}


@pytest.mark.django_db
def test_bulk_reassign_api_returns_400_with_invalid_ids():
    op = Operator.objects.create(full_name="OP", status=OperatorStatus.ACTIVE)
    orphan = _orphan(1)
    other = Operator.objects.create(full_name="OTHER", status=OperatorStatus.ACTIVE)
    already = Lead.objects.create(
        full_name="already",
        phone="+998999999999",
        status=LeadStatus.ASSIGNED,
        operator=other,
    )

    mgr = _mgr()
    c = APIClient()
    c.force_authenticate(user=mgr)

    r = c.post(
        "/api/leads/bulk-reassign/",
        {"lead_ids": [orphan.id, already.id], "operator_id": op.id},
        format="json",
    )
    assert r.status_code == 400
    assert already.id in r.data.get("already_assigned_ids", [])


@pytest.mark.django_db
def test_orphans_api_returns_pool_with_counts():
    _orphan(1)
    _orphan(2)
    _orphan(3)
    # Один уже назначенный — в orphans не попадает.
    op = Operator.objects.create(full_name="OP", status=OperatorStatus.ACTIVE)
    Lead.objects.create(
        full_name="assigned",
        phone="+998999999999",
        status=LeadStatus.ASSIGNED,
        operator=op,
    )

    mgr = _mgr()
    c = APIClient()
    c.force_authenticate(user=mgr)

    r = c.get("/api/leads/orphans/")
    assert r.status_code == 200, r.content
    assert r.data["count"] == 3
    assert "counts_by_source" in r.data
    assert "counts_by_status" in r.data

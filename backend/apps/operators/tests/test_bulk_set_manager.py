"""
POST /api/operators/bulk-set-manager/ (design-atlas V2, 2026-10-14).

Права на `managed_by_id` — те же, что у PATCH /operators/<id>/
(`OperatorSerializer.validate`): manager/team_lead → только себе или null,
super_manager → любому senior, superadmin → кому угодно. Частичные ошибки
(несуществующий id, оператор вне scope) не валят запрос — попадают в
`errors`, остальные переносятся. Audit-лог как у одиночного PATCH.
"""

from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from apps.audit.models import AuditLog
from apps.operators.models import Operator
from apps.users.models import Profile, Role

User = get_user_model()

URL = "/api/operators/bulk-set-manager/"


def _mk_user(username: str, role: str, **profile) -> User:
    u = User.objects.create_user(username=username, password="x")
    Profile.objects.create(user=u, role=role, **profile)
    return u


def _client(user) -> APIClient:
    c = APIClient()
    c.force_authenticate(user)
    return c


@pytest.fixture
def manager(db):
    return _mk_user("bulk_mgr", Role.MANAGER)


@pytest.fixture
def manager2(db):
    return _mk_user("bulk_mgr2", Role.MANAGER)


@pytest.fixture
def super_manager(db):
    return _mk_user("bulk_sm", Role.SUPER_MANAGER)


@pytest.fixture
def ops(db, manager, manager2):
    return [
        Operator.objects.create(full_name="Op1", status="active"),
        Operator.objects.create(full_name="Op2", status="active"),
        Operator.objects.create(full_name="Op3", status="active", managed_by=manager2),
    ]


@pytest.mark.django_db
def test_super_manager_moves_all_to_manager(super_manager, manager, ops):
    ids = [o.id for o in ops]
    resp = _client(super_manager).post(
        URL, {"operator_ids": ids, "managed_by_id": manager.id}, format="json"
    )
    assert resp.status_code == 200, resp.data
    assert resp.data == {"updated": ids, "errors": []}
    assert set(Operator.objects.filter(id__in=ids).values_list("managed_by_id", flat=True)) == {
        manager.id
    }
    logs = AuditLog.objects.filter(entity="operators.Operator", action="update")
    assert set(logs.values_list("entity_id", flat=True)) == {str(i) for i in ids}
    assert all("managed_by" in log.changes for log in logs)


@pytest.mark.django_db
def test_partial_errors_unknown_and_out_of_scope(manager, ops):
    """manager видит Op1/Op2 (legacy pool), Op3 чужой → error; 999999 → error."""
    resp = _client(manager).post(
        URL,
        {"operator_ids": [ops[0].id, ops[2].id, 999999, ops[1].id], "managed_by_id": manager.id},
        format="json",
    )
    assert resp.status_code == 200, resp.data
    assert resp.data["updated"] == [ops[0].id, ops[1].id]
    err_ids = [e["id"] for e in resp.data["errors"]]
    assert err_ids == [ops[2].id, 999999]
    assert all(e["detail"] for e in resp.data["errors"])
    ops[2].refresh_from_db()
    assert ops[2].managed_by_id != manager.id


@pytest.mark.django_db
def test_manager_cannot_assign_to_other_manager(manager, manager2, ops):
    resp = _client(manager).post(
        URL, {"operator_ids": [ops[0].id], "managed_by_id": manager2.id}, format="json"
    )
    assert resp.status_code == 400
    assert "managed_by_id" in resp.data
    ops[0].refresh_from_db()
    assert ops[0].managed_by_id is None


@pytest.mark.django_db
def test_super_manager_cannot_assign_to_operator_user(super_manager, ops):
    op_user = _mk_user("bulk_op", Role.OPERATOR, operator=ops[0])
    resp = _client(super_manager).post(
        URL, {"operator_ids": [ops[0].id], "managed_by_id": op_user.id}, format="json"
    )
    assert resp.status_code == 400


@pytest.mark.django_db
def test_unassign_with_null(super_manager, manager2, ops):
    resp = _client(super_manager).post(
        URL, {"operator_ids": [ops[2].id], "managed_by_id": None}, format="json"
    )
    assert resp.status_code == 200
    ops[2].refresh_from_db()
    assert ops[2].managed_by_id is None


@pytest.mark.django_db
def test_operator_role_forbidden(ops):
    op_user = _mk_user("bulk_op2", Role.OPERATOR, operator=ops[0])
    resp = _client(op_user).post(
        URL, {"operator_ids": [ops[0].id], "managed_by_id": None}, format="json"
    )
    assert resp.status_code == 403


@pytest.mark.django_db
def test_validation_errors(super_manager, ops):
    c = _client(super_manager)
    assert c.post(URL, {"operator_ids": [], "managed_by_id": None}, format="json").status_code == 400
    assert c.post(URL, {"operator_ids": [ops[0].id]}, format="json").status_code == 400
    assert (
        c.post(URL, {"operator_ids": [ops[0].id], "managed_by_id": 987654}, format="json").status_code
        == 400
    )


@pytest.mark.django_db
def test_idempotent_same_owner_no_extra_audit(super_manager, manager2, ops):
    resp = _client(super_manager).post(
        URL, {"operator_ids": [ops[2].id], "managed_by_id": manager2.id}, format="json"
    )
    assert resp.data == {"updated": [ops[2].id], "errors": []}
    assert not AuditLog.objects.filter(entity="operators.Operator", entity_id=str(ops[2].id)).exists()

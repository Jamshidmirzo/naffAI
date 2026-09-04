"""
Tests for GET/PUT /api/payroll/rules/operator/<id>/.

Что покрываем:
- GET без override → source=global, effective=global rule.
- PUT с полями threshold/payout_type/payout_value → создаётся override,
  повторный PUT обновляет ту же строку (unique-констрейнт не ломается).
- PUT {reset: true} → override удалён, дальше source=global.
- PUT валидация: неизвестный payout_type → 400.
- PUT без полей и без reset → 400.
- Permission: operator без manager-роли → 403; аноним → 401.
- Аудит-лог создаётся на upsert (create/update) и на reset (delete).
"""

from decimal import Decimal

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from apps.audit.models import AuditLog
from apps.operators.models import Operator, OperatorStatus
from apps.payroll.models import PayoutType, PayrollRule, PayrollScope
from apps.payroll.services import payroll_rule_create
from apps.users.models import Profile, Role

User = get_user_model()


# ---------- fixtures ----------


@pytest.fixture
def manager_user(db):
    u = User.objects.create(username="mgr")
    Profile.objects.create(user=u, role=Role.MANAGER)
    return u


@pytest.fixture
def operator_user(db):
    op = Operator.objects.create(full_name="Op User Owner", status=OperatorStatus.ACTIVE)
    u = User.objects.create(username="op-user")
    Profile.objects.create(user=u, role=Role.OPERATOR, operator=op)
    return u


@pytest.fixture
def manager_client(manager_user):
    c = APIClient()
    c.force_authenticate(user=manager_user)
    return c


@pytest.fixture
def operator_client(operator_user):
    c = APIClient()
    c.force_authenticate(user=operator_user)
    return c


@pytest.fixture
def operator(db):
    return Operator.objects.create(full_name="Test Bonu", status=OperatorStatus.ACTIVE)


@pytest.fixture
def global_rule(db, manager_user):
    return payroll_rule_create(
        user=manager_user,
        scope=PayrollScope.GLOBAL,
        threshold=Decimal("50000000"),
        payout_type=PayoutType.PERCENT,
        payout_value=Decimal("3"),
    )


def _url(operator_id: int) -> str:
    return f"/api/payroll/rules/operator/{operator_id}/"


# ---------- GET ----------


@pytest.mark.django_db
def test_get_fallback_to_global(manager_client, operator, global_rule):
    resp = manager_client.get(_url(operator.id))
    assert resp.status_code == 200, resp.content
    data = resp.json()
    assert data["operator_id"] == operator.id
    assert data["source"] == "global"
    assert data["override"] is None
    assert data["global"]["id"] == global_rule.id
    assert data["effective"]["id"] == global_rule.id
    assert data["effective"]["scope"] == PayrollScope.GLOBAL


@pytest.mark.django_db
def test_get_prefers_override(manager_client, operator, global_rule):
    override = PayrollRule.objects.create(
        scope=PayrollScope.OPERATOR,
        operator=operator,
        threshold=Decimal("30000000"),
        payout_type=PayoutType.PERCENT,
        payout_value=Decimal("5"),
    )
    resp = manager_client.get(_url(operator.id))
    assert resp.status_code == 200
    data = resp.json()
    assert data["source"] == "override"
    assert data["override"]["id"] == override.id
    assert data["effective"]["id"] == override.id
    assert data["global"]["id"] == global_rule.id
    assert data["effective"]["threshold"] == "30000000.00"


@pytest.mark.django_db
def test_get_unknown_operator_returns_404(manager_client):
    resp = manager_client.get(_url(99999))
    assert resp.status_code == 404


# ---------- PUT: create override ----------


@pytest.mark.django_db
def test_put_creates_override(manager_client, operator, global_rule):
    resp = manager_client.put(
        _url(operator.id),
        data={
            "threshold": "30000000",
            "payout_type": PayoutType.PERCENT,
            "payout_value": "5",
        },
        format="json",
    )
    assert resp.status_code == 200, resp.content
    data = resp.json()
    assert data["source"] == "override"
    assert data["override"]["threshold"] == "30000000.00"
    assert data["override"]["payout_value"] == "5.00"

    assert (
        PayrollRule.objects.filter(
            scope=PayrollScope.OPERATOR,
            operator_id=operator.id,
            is_active=True,
        ).count()
        == 1
    )
    # audit-log: create
    assert AuditLog.objects.filter(
        entity="payroll.PayrollRule",
        action="create",
    ).exists()


@pytest.mark.django_db
def test_put_second_call_updates_same_row(manager_client, operator, global_rule):
    # 1-й upsert — создаёт override.
    manager_client.put(
        _url(operator.id),
        data={"threshold": "30000000", "payout_type": PayoutType.PERCENT, "payout_value": "5"},
        format="json",
    )
    # 2-й upsert — должен обновить ту же строку, не нарушая
    # `uniq_active_operator_rule`.
    resp = manager_client.put(
        _url(operator.id),
        data={"threshold": "40000000", "payout_type": PayoutType.FIXED, "payout_value": "2000000"},
        format="json",
    )
    assert resp.status_code == 200, resp.content
    rows = PayrollRule.objects.filter(
        scope=PayrollScope.OPERATOR,
        operator_id=operator.id,
        is_active=True,
    )
    assert rows.count() == 1
    r = rows.get()
    assert r.threshold == Decimal("40000000")
    assert r.payout_type == PayoutType.FIXED
    assert r.payout_value == Decimal("2000000")
    # audit-log: update writes with action=update on the same rule_id.
    assert AuditLog.objects.filter(
        entity="payroll.PayrollRule",
        entity_id=str(r.id),
        action="update",
    ).exists()


@pytest.mark.django_db
def test_put_reset_deletes_override(manager_client, operator, global_rule):
    override = PayrollRule.objects.create(
        scope=PayrollScope.OPERATOR,
        operator=operator,
        threshold=Decimal("30000000"),
        payout_type=PayoutType.PERCENT,
        payout_value=Decimal("5"),
    )
    resp = manager_client.put(_url(operator.id), data={"reset": True}, format="json")
    assert resp.status_code == 200, resp.content
    data = resp.json()
    assert data["source"] == "global"
    assert data["override"] is None
    assert data["effective"]["id"] == global_rule.id

    assert not PayrollRule.objects.filter(id=override.id).exists()
    # audit-log: delete
    assert AuditLog.objects.filter(
        entity="payroll.PayrollRule",
        entity_id=str(override.id),
        action="delete",
    ).exists()


@pytest.mark.django_db
def test_put_reset_when_nothing_to_delete_is_noop(manager_client, operator, global_rule):
    # Нет override — reset должен вернуть 200 и не писать audit-лог.
    resp = manager_client.put(_url(operator.id), data={"reset": True}, format="json")
    assert resp.status_code == 200
    data = resp.json()
    assert data["source"] == "global"
    assert not AuditLog.objects.filter(
        entity="payroll.PayrollRule", action="delete"
    ).exists()


# ---------- validation ----------


@pytest.mark.django_db
def test_put_invalid_payout_type_400(manager_client, operator, global_rule):
    resp = manager_client.put(
        _url(operator.id),
        data={"threshold": "30000000", "payout_type": "banana", "payout_value": "5"},
        format="json",
    )
    assert resp.status_code == 400, resp.content
    body = resp.json()
    assert "payout_type" in body


@pytest.mark.django_db
def test_put_empty_body_400(manager_client, operator, global_rule):
    resp = manager_client.put(_url(operator.id), data={}, format="json")
    assert resp.status_code == 400, resp.content


# ---------- permissions ----------


@pytest.mark.django_db
def test_operator_forbidden(operator_client, operator, global_rule):
    resp = operator_client.get(_url(operator.id))
    assert resp.status_code == 403

    resp = operator_client.put(
        _url(operator.id),
        data={"threshold": "1", "payout_type": PayoutType.PERCENT, "payout_value": "1"},
        format="json",
    )
    assert resp.status_code == 403


@pytest.mark.django_db
def test_anonymous_forbidden(db, operator, global_rule):
    client = APIClient()
    resp = client.get(_url(operator.id))
    assert resp.status_code in (401, 403)
    resp = client.put(_url(operator.id), data={"reset": True}, format="json")
    assert resp.status_code in (401, 403)

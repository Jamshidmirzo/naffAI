import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from apps.users.models import Profile, Role
from apps.operators.models import Operator
from apps.payroll.models import PayrollRule, PayrollScope, PayoutType
from apps.payroll.services import payroll_rule_create, payroll_rule_update
from apps.audit.models import AuditLog

User = get_user_model()

@pytest.fixture
def user(db):
    u = User.objects.create(username="testuser")
    Profile.objects.create(user=u, role=Role.TEAM_LEAD)
    return u

@pytest.fixture
def api_client(user):
    client = APIClient()
    client.force_authenticate(user=user)
    return client

@pytest.mark.django_db
def test_payroll_rule_create_audited(user):
    rule = payroll_rule_create(
        user=user,
        scope=PayrollScope.GLOBAL,
        threshold=50000000,
        payout_type=PayoutType.PERCENT,
        payout_value=3
    )
    
    log = AuditLog.objects.get(entity="payroll.PayrollRule", entity_id=str(rule.id))
    assert log.action == "create"
    assert log.user == user
    assert log.changes["threshold"] == "50000000"


@pytest.mark.django_db
def test_payroll_rule_update_audited(user):
    rule = payroll_rule_create(
        user=user,
        scope=PayrollScope.GLOBAL,
        threshold=50000000,
        payout_type=PayoutType.PERCENT,
        payout_value=3
    )
    
    payroll_rule_update(rule=rule, user=user, threshold=60000000)
    
    # get the latest log
    log = AuditLog.objects.filter(entity="payroll.PayrollRule", entity_id=str(rule.id)).order_by('-created_at').first()
    assert log.action == "update"
    assert log.user == user
    assert "threshold" in log.changes


@pytest.mark.django_db
def test_payroll_export_audited(api_client, user):
    response = api_client.get("/api/payroll/monthly/export.xlsx?year=2024&month=7")
    assert response.status_code == 200
    
    log = AuditLog.objects.get(entity="payroll.PayrollExport", entity_id="2024-07")
    assert log.action == "override"
    assert log.user == user
    assert log.changes["year"] == 2024
    assert log.changes["month"] == 7

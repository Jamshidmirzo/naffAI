"""
API `/api/leads/distribute-now/` — ручной триггер утренней раздачи.
Использует тот же сервис `morning_distribute_leads`.
"""

from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from apps.leads.models import Lead, LeadStatus
from apps.operators.models import Operator, OperatorStatus
from apps.system_settings.models import SystemSetting
from apps.users.models import Profile, Role

User = get_user_model()


def _mgr():
    user = User.objects.create_user(username="mgr", password="mgrpass1")
    Profile.objects.create(user=user, role=Role.MANAGER)
    return user


def _operator_user():
    user = User.objects.create_user(username="op", password="oppass123")
    op = Operator.objects.create(full_name="OpUser", status=OperatorStatus.ACTIVE)
    Profile.objects.create(user=user, role=Role.OPERATOR, operator=op)
    return user


def _mk_orphan(idx: int) -> Lead:
    return Lead.objects.create(
        full_name=f"O-{idx}",
        phone=f"+99890{idx:07d}",
        status=LeadStatus.NEW,
        operator=None,
    )


@pytest.mark.django_db
def test_distribute_now_splits_orphans_evenly():
    op1 = Operator.objects.create(full_name="Op1", status=OperatorStatus.ACTIVE)
    op2 = Operator.objects.create(full_name="Op2", status=OperatorStatus.ACTIVE)
    for i in range(6):
        _mk_orphan(i)

    mgr = _mgr()
    c = APIClient()
    c.force_authenticate(user=mgr)

    r = c.post("/api/leads/distribute-now/")
    assert r.status_code == 200, r.content
    assert r.data["total"] == 6
    # 6 / 2 = 3 каждому.
    assert sorted(r.data["assigned"].values()) == [3, 3]
    assert set(r.data["assigned"].keys()) == {str(op1.id), str(op2.id)}

    # Все сироты стали чьими-то.
    assert Lead.objects.filter(operator__isnull=True).count() == 0


@pytest.mark.django_db
def test_distribute_now_operator_forbidden():
    Operator.objects.create(full_name="Op", status=OperatorStatus.ACTIVE)
    _mk_orphan(1)

    op_user = _operator_user()
    c = APIClient()
    c.force_authenticate(user=op_user)

    r = c.post("/api/leads/distribute-now/")
    assert r.status_code == 403


@pytest.mark.django_db
def test_distribute_now_respects_killswitch():
    Operator.objects.create(full_name="Op", status=OperatorStatus.ACTIVE)
    _mk_orphan(1)

    ss = SystemSetting.get_solo()
    ss.auto_distribution_enabled = False
    ss.save(update_fields=["auto_distribution_enabled", "updated_at"])

    mgr = _mgr()
    c = APIClient()
    c.force_authenticate(user=mgr)

    r = c.post("/api/leads/distribute-now/")
    assert r.status_code == 400
    assert Lead.objects.filter(operator__isnull=True).count() == 1


@pytest.mark.django_db
def test_distribute_now_with_no_orphans_is_noop():
    Operator.objects.create(full_name="Op", status=OperatorStatus.ACTIVE)

    mgr = _mgr()
    c = APIClient()
    c.force_authenticate(user=mgr)

    r = c.post("/api/leads/distribute-now/")
    assert r.status_code == 200
    assert r.data["total"] == 0
    assert r.data["assigned"] == {}

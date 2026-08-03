"""
Killswitch `SystemSetting.auto_distribution_enabled` действует на все
три триггера раздачи:
- утренняя раздача (morning_distribute_leads)
- refill-по-N при закрытии лида (_run_refill_if_empty → refill_operator_leads)
- watcher (management-команда refill_idle_operators)

Плюс PATCH API проставляет updated_by/updated_at.
"""

from __future__ import annotations

from io import StringIO

import pytest
from django.contrib.auth import get_user_model
from django.core.management import call_command
from rest_framework.test import APIClient

from apps.audit.models import AuditLog
from apps.leads.models import Lead, LeadAssignment, LeadAssignmentSource, LeadStatus
from apps.leads.services import lead_update_status, morning_distribute_leads
from apps.operators.models import Operator, OperatorStatus
from apps.system_settings.models import SystemSetting
from apps.users.models import Profile, Role

User = get_user_model()


def _disable():
    obj = SystemSetting.get_solo()
    obj.auto_distribution_enabled = False
    obj.save(update_fields=["auto_distribution_enabled", "updated_at"])


def _mk_orphan(i: int) -> Lead:
    return Lead.objects.create(
        full_name=f"P-{i}",
        phone=f"+99890{i:07d}",
        status=LeadStatus.NEW,
        operator=None,
    )


@pytest.mark.django_db
def test_flag_false_morning_returns_empty():
    Operator.objects.create(full_name="OP", status=OperatorStatus.ACTIVE)
    for i in range(5):
        _mk_orphan(i)

    _disable()

    assert morning_distribute_leads(seed=1) == {}
    # Сироты остались.
    assert Lead.objects.filter(operator__isnull=True).count() == 5


@pytest.mark.django_db(transaction=True, serialized_rollback=True)
def test_flag_false_refill_on_close_noop():
    op = Operator.objects.create(full_name="OP", status=OperatorStatus.ACTIVE)
    only = Lead.objects.create(
        full_name="active",
        phone="+998990000001",
        status=LeadStatus.ASSIGNED,
        operator=op,
    )
    for i in range(10):
        _mk_orphan(i)

    _disable()

    lead_update_status(lead=only, status=LeadStatus.WON)

    # У оператора теперь только закрытый + 0 новых (refill не сработал).
    assert Lead.objects.filter(operator=op).exclude(status=LeadStatus.WON).count() == 0
    assert LeadAssignment.objects.filter(
        source=LeadAssignmentSource.AUTO_REFILL
    ).count() == 0


@pytest.mark.django_db
def test_flag_false_watcher_command_skips():
    Operator.objects.create(full_name="OP", status=OperatorStatus.ACTIVE)
    for i in range(5):
        _mk_orphan(i)

    _disable()

    out = StringIO()
    call_command("refill_idle_operators", stdout=out)

    assert "disabled" in out.getvalue()
    assert Lead.objects.filter(operator__isnull=True).count() == 5


@pytest.mark.django_db
def test_settings_get_returns_current_state():
    user = User.objects.create_user(username="mgr", password="mgrpass1")
    Profile.objects.create(user=user, role=Role.MANAGER)
    c = APIClient()
    c.force_authenticate(user=user)

    r = c.get("/api/settings/distribution/")
    assert r.status_code == 200, r.content
    assert r.data["auto_distribution_enabled"] is True
    assert r.data["updated_by"] is None


@pytest.mark.django_db
def test_settings_patch_stamps_actor_and_writes_audit():
    user = User.objects.create_user(username="mgr", password="mgrpass1")
    Profile.objects.create(user=user, role=Role.MANAGER)
    c = APIClient()
    c.force_authenticate(user=user)

    r = c.patch(
        "/api/settings/distribution/",
        {"auto_distribution_enabled": False},
        format="json",
    )
    assert r.status_code == 200, r.content
    assert r.data["auto_distribution_enabled"] is False
    assert r.data["updated_by"] == {"id": user.id, "full_name": "mgr"}
    assert r.data["updated_at"]

    # Audit-log получил запись.
    entry = AuditLog.objects.filter(entity="system_settings.SystemSetting").order_by("-created_at").first()
    assert entry is not None
    assert entry.user_id == user.id
    assert entry.changes == {"auto_distribution_enabled": {"from": True, "to": False}}


@pytest.mark.django_db
def test_settings_patch_forbidden_for_operator():
    op = Operator.objects.create(full_name="Op", status=OperatorStatus.ACTIVE)
    user = User.objects.create_user(username="op", password="oppass123")
    Profile.objects.create(user=user, role=Role.OPERATOR, operator=op)
    c = APIClient()
    c.force_authenticate(user=user)

    r = c.patch(
        "/api/settings/distribution/",
        {"auto_distribution_enabled": False},
        format="json",
    )
    assert r.status_code == 403


@pytest.mark.django_db
def test_settings_patch_noop_when_value_unchanged():
    """Пустой diff → нет новой записи в audit."""
    user = User.objects.create_user(username="mgr", password="mgrpass1")
    Profile.objects.create(user=user, role=Role.MANAGER)
    c = APIClient()
    c.force_authenticate(user=user)

    audit_before = AuditLog.objects.filter(entity="system_settings.SystemSetting").count()
    r = c.patch(
        "/api/settings/distribution/",
        {"auto_distribution_enabled": True},  # уже True
        format="json",
    )
    assert r.status_code == 200
    assert AuditLog.objects.filter(entity="system_settings.SystemSetting").count() == audit_before

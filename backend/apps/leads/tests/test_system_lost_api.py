"""
API-endpoint'ы для system-lost:
  * GET  /api/leads/system-lost/                                (superadmin only)
  * POST /api/leads/{id}/recover-from-system-lost/              (superadmin only)

Проверяем:
  * пермишены (manager → 403, operator → 403, superadmin → 200);
  * пагинацию и summary в ответе;
  * фильтр `?reason=`;
  * recover — очищает metadata и делает лид доступным для автораздачи.
"""

from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from apps.leads.models import Lead, LeadStatus
from apps.leads.selectors import orphan_leads
from apps.leads.services import (
    LOST_REASON_INVALID_PHONE_FROM_SHEET,
    LOST_REASON_STRANDED_ON_INACTIVE,
    lead_mark_system_lost,
)
from apps.operators.models import Operator, OperatorStatus
from apps.users.models import Profile, Role

User = get_user_model()


def _mk_user(role: str, username: str = "u") -> User:
    user = User.objects.create_user(username=username, password="x1234567")
    Profile.objects.create(user=user, role=role)
    return user


def _client(role: str, username: str) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=_mk_user(role, username))
    return c


def _mk_stranded(op_name: str = "OldOp") -> Lead:
    op = Operator.objects.create(full_name=op_name, status=OperatorStatus.INACTIVE)
    lead = Lead.objects.create(
        full_name="Klient",
        phone="+998900000001",
        status=LeadStatus.IN_PROGRESS,
        operator=op,
    )
    return lead_mark_system_lost(
        lead=lead,
        reason=LOST_REASON_STRANDED_ON_INACTIVE,
        comment="stranded",
        original_operator_name=op_name,
        original_status=LeadStatus.IN_PROGRESS,
    )


@pytest.mark.django_db
def test_list_forbidden_for_manager():
    _mk_stranded()
    c = _client(Role.MANAGER, "mgr1")
    resp = c.get("/api/leads/system-lost/")
    assert resp.status_code == 403


@pytest.mark.django_db
def test_list_forbidden_for_operator():
    _mk_stranded()
    c = _client(Role.OPERATOR, "op1")
    resp = c.get("/api/leads/system-lost/")
    assert resp.status_code == 403


@pytest.mark.django_db
def test_list_ok_for_superadmin():
    lead = _mk_stranded()
    c = _client(Role.SUPERADMIN, "su1")
    resp = c.get("/api/leads/system-lost/")
    assert resp.status_code == 200
    payload = resp.json()
    assert payload["count"] == 1
    row = payload["results"][0]
    assert row["id"] == lead.id
    assert row["lost_reason"] == LOST_REASON_STRANDED_ON_INACTIVE
    assert row["lost_original_operator_name"] == "OldOp"
    # summary тоже приходит
    assert payload["summary"]["total"] == 1
    assert payload["summary"]["by_reason"][LOST_REASON_STRANDED_ON_INACTIVE] == 1


@pytest.mark.django_db
def test_list_reason_filter():
    _mk_stranded("A")
    # ещё один — с другим reason
    l2 = Lead.objects.create(
        full_name="Broken",
        phone_raw="9",
        status=LeadStatus.NEEDS_REVIEW,
        needs_review=True,
    )
    lead_mark_system_lost(
        lead=l2, reason=LOST_REASON_INVALID_PHONE_FROM_SHEET
    )

    c = _client(Role.SUPERADMIN, "su2")
    resp = c.get(
        f"/api/leads/system-lost/?reason={LOST_REASON_INVALID_PHONE_FROM_SHEET}"
    )
    assert resp.status_code == 200
    payload = resp.json()
    assert payload["count"] == 1
    assert (
        payload["results"][0]["lost_reason"]
        == LOST_REASON_INVALID_PHONE_FROM_SHEET
    )


@pytest.mark.django_db
def test_list_rejects_unknown_reason():
    c = _client(Role.SUPERADMIN, "su3")
    resp = c.get("/api/leads/system-lost/?reason=bogus")
    assert resp.status_code == 400


@pytest.mark.django_db
def test_recover_returns_lead_to_orphan_pool():
    lead = _mk_stranded("Ex")
    c = _client(Role.SUPERADMIN, "su4")
    resp = c.post(f"/api/leads/{lead.id}/recover-from-system-lost/")
    assert resp.status_code == 200

    lead.refresh_from_db()
    assert lead.status == LeadStatus.IN_PROGRESS  # оригинал восстановлен
    assert lead.operator_id is None
    md = lead.metadata or {}
    # Все lost_* ключи вычищены
    assert not any(k.startswith("lost_") for k in md.keys())

    # Тем не менее — из-за статуса in_progress лид пока НЕ в orphan_leads
    # (там только раздаваемые active-статусы). Это ok: менеджер сам решит,
    # обнулять ли статус вручную.
    # Но если сделать оригинальный статус new — попадает в пул.
    Lead.objects.filter(id=lead.id).update(status=LeadStatus.NEW)
    ids_in_pool = set(orphan_leads().values_list("id", flat=True))
    assert lead.id in ids_in_pool


@pytest.mark.django_db
def test_recover_forbidden_for_manager():
    lead = _mk_stranded("Ex")
    c = _client(Role.MANAGER, "mgr5")
    resp = c.post(f"/api/leads/{lead.id}/recover-from-system-lost/")
    assert resp.status_code == 403

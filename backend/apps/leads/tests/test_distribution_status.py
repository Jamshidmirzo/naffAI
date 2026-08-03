"""
Диагностический виджет «Статус распределения»:
селектор `operators_distribution_status()` + API `/api/leads/distribution-status/`.

Проверяем причины (reason), сортировку eligible → non-eligible,
и что endpoint доступен только менеджеру.
"""

from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model
from django.test import override_settings
from rest_framework.test import APIClient

from apps.leads.models import Lead, LeadStatus
from apps.leads.selectors import operators_distribution_status
from apps.operators.models import Operator, OperatorStatus
from apps.users.models import Profile, Role

User = get_user_model()


def _mk_op(name: str, status: str = OperatorStatus.ACTIVE) -> Operator:
    return Operator.objects.create(full_name=name, status=status)


def _mk_leads(op: Operator, n: int, *, prefix: str = "L") -> list[Lead]:
    leads: list[Lead] = []
    for i in range(n):
        leads.append(
            Lead.objects.create(
                full_name=f"{prefix}-{op.id}-{i}",
                phone=f"+998{op.id:03d}{i:07d}",
                status=LeadStatus.ASSIGNED,
                operator=op,
            )
        )
    return leads


def _mgr():
    user = User.objects.create_user(username="mgr", password="mgrpass1")
    Profile.objects.create(user=user, role=Role.MANAGER)
    return user


def _operator_user():
    user = User.objects.create_user(username="op", password="oppass123")
    op = Operator.objects.create(full_name="OpUser", status=OperatorStatus.ACTIVE)
    Profile.objects.create(user=user, role=Role.OPERATOR, operator=op)
    return user


# ---- selector ------------------------------------------------------------


@pytest.mark.django_db
@override_settings(RR_BATCH_SIZE=5, MORNING_GATE_ENABLED=False)
def test_status_marks_over_quota_operators_as_ineligible():
    op_free = _mk_op("Free")     # 3 лида → eligible
    op_at = _mk_op("AtQuota")    # 5 лидов → квота (>=5)
    op_over = _mk_op("Over")     # 8 лидов → квота

    _mk_leads(op_free, 3)
    _mk_leads(op_at, 5)
    _mk_leads(op_over, 8)

    rows = operators_distribution_status()
    by_id = {r["id"]: r for r in rows}

    assert by_id[op_free.id]["eligible"] is True
    assert by_id[op_free.id]["working_count"] == 3
    assert by_id[op_free.id]["reason"] == "ок — участвует в RR"

    assert by_id[op_at.id]["eligible"] is False
    assert "Квота" in by_id[op_at.id]["reason"]
    assert "5/5" in by_id[op_at.id]["reason"]

    assert by_id[op_over.id]["eligible"] is False
    assert "8/5" in by_id[op_over.id]["reason"]


@pytest.mark.django_db
@override_settings(RR_BATCH_SIZE=5, MORNING_GATE_ENABLED=False)
def test_status_sorts_eligible_first_then_by_load():
    op_free_low = _mk_op("Low")
    op_free_high = _mk_op("High")
    op_over_big = _mk_op("OverBig")
    op_over_small = _mk_op("OverSmall")

    _mk_leads(op_free_low, 1)
    _mk_leads(op_free_high, 4)
    _mk_leads(op_over_big, 12)
    _mk_leads(op_over_small, 6)

    rows = operators_distribution_status()

    order = [r["id"] for r in rows]
    # eligible первым (по working ASC), non-eligible вторым (по working DESC).
    assert order == [
        op_free_low.id,
        op_free_high.id,
        op_over_big.id,
        op_over_small.id,
    ]


@pytest.mark.django_db
@override_settings(RR_BATCH_SIZE=5, MORNING_GATE_ENABLED=False)
def test_status_excludes_inactive_operators():
    active_op = _mk_op("Active")
    inactive_op = _mk_op("Inactive", status=OperatorStatus.INACTIVE)
    _mk_leads(active_op, 2)
    _mk_leads(inactive_op, 2)

    rows = operators_distribution_status()
    ids = {r["id"] for r in rows}
    assert active_op.id in ids
    # Селектор по бизнесу показывает только ACTIVE — неактивных отфильтровали
    # в отдельной вкладке «Уволенные»; здесь они бы забивали таблицу.
    assert inactive_op.id not in ids


@pytest.mark.django_db
@override_settings(RR_BATCH_SIZE=5, MORNING_GATE_ENABLED=False)
def test_status_counts_postponed_separately():
    op = _mk_op("Op")
    from django.utils import timezone

    _mk_leads(op, 2)
    # 3 отложенных — не считаются в working_count, но видны отдельным столбцом.
    for i in range(3):
        Lead.objects.create(
            full_name=f"P-{i}",
            phone=f"+99811{i:07d}",
            status=LeadStatus.ASSIGNED,
            operator=op,
            postponed_at=timezone.now(),
        )

    rows = operators_distribution_status()
    row = next(r for r in rows if r["id"] == op.id)
    assert row["working_count"] == 2
    assert row["postponed_count"] == 3
    assert row["eligible"] is True


# ---- API -----------------------------------------------------------------


@pytest.mark.django_db
@override_settings(RR_BATCH_SIZE=5, MORNING_GATE_ENABLED=False)
def test_distribution_status_api_manager_200():
    op = _mk_op("OP-A")
    _mk_leads(op, 2)
    # Пара сирот для orphans_count.
    for i in range(3):
        Lead.objects.create(
            full_name=f"O-{i}",
            phone=f"+99899{i:07d}",
            status=LeadStatus.NEW,
        )

    mgr = _mgr()
    c = APIClient()
    c.force_authenticate(user=mgr)

    r = c.get("/api/leads/distribution-status/")
    assert r.status_code == 200, r.content
    body = r.data
    assert body["auto_distribution_enabled"] is True
    assert body["rr_batch_size"] == 5
    assert body["orphans_count"] == 3
    assert body["orphans_oldest"] is not None
    assert len(body["operators"]) == 1
    assert body["operators"][0]["id"] == op.id
    assert body["operators"][0]["working_count"] == 2
    assert body["operators"][0]["eligible"] is True


@pytest.mark.django_db
def test_distribution_status_api_operator_forbidden():
    _mk_op("OP")
    op_user = _operator_user()

    c = APIClient()
    c.force_authenticate(user=op_user)
    r = c.get("/api/leads/distribution-status/")
    assert r.status_code == 403


@pytest.mark.django_db
def test_distribution_status_api_anonymous_401_or_403():
    c = APIClient()
    r = c.get("/api/leads/distribution-status/")
    # DRF default: 401 при отсутствии auth-credentials, но некоторые
    # проекты гоняют через session-only → 403. Обе трактовки корректны.
    assert r.status_code in (401, 403)

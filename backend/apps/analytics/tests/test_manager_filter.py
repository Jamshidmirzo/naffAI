"""
`?manager_id=<id>|none` для `/api/analytics/dashboard-summary/` и
`/api/analytics/leaderboard/` (design-atlas V2, 2026-10-14).

  * только super_manager / superadmin; у manager'а параметр игнорируется;
  * без параметра поведение не меняется (кэш, глобальные цифры);
  * мусор → 400.
"""

from __future__ import annotations

from decimal import Decimal

import pytest
from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.utils import timezone
from rest_framework.test import APIClient

from apps.catalog.models import Channel
from apps.operators.models import Operator
from apps.sales.models import Sale, SaleOperator
from apps.users.models import Profile, Role

User = get_user_model()

SUMMARY = "/api/analytics/dashboard-summary/"
BOARD = "/api/analytics/leaderboard/"


def _mk_user(username, role):
    u = User.objects.create_user(username=username, password="x")
    Profile.objects.create(user=u, role=role)
    return u


def _client(user):
    c = APIClient()
    c.force_authenticate(user)
    return c


@pytest.fixture(autouse=True)
def _clear_cache():
    cache.clear()
    yield
    cache.clear()


@pytest.fixture
def world(db):
    m1 = _mk_user("mf_m1", Role.MANAGER)
    m2 = _mk_user("mf_m2", Role.MANAGER)
    op1 = Operator.objects.create(full_name="Op M1", status="active", managed_by=m1)
    op2 = Operator.objects.create(full_name="Op M2", status="active", managed_by=m2)
    op3 = Operator.objects.create(full_name="Op Pool", status="active")
    ch = Channel.objects.create(name="Telegram")
    for op_, amount in ((op1, "10000000"), (op2, "20000000"), (op3, "40000000")):
        s = Sale.objects.create(
            imei="490154203237518", phone_model="X", operator=op_, channel=ch,
            amount=Decimal(amount), discount=Decimal("0"), sold_at=timezone.now(),
            status="confirmed",
        )
        SaleOperator.objects.create(sale=s, operator=op_, amount=Decimal(amount))
    return {"m1": m1, "m2": m2, "op1": op1, "op2": op2, "op3": op3}


def _board_ids(resp):
    return {r["operator_id"] for r in resp.data}


@pytest.mark.django_db
def test_leaderboard_manager_filter_super_manager(world):
    sm = _client(_mk_user("mf_sm", Role.SUPER_MANAGER))
    assert _board_ids(sm.get(BOARD, {"period": "day"})) == {
        world["op1"].id, world["op2"].id, world["op3"].id
    }
    assert _board_ids(sm.get(BOARD, {"period": "day", "manager_id": world["m1"].id})) == {
        world["op1"].id
    }
    assert _board_ids(sm.get(BOARD, {"period": "day", "manager_id": "none"})) == {
        world["op3"].id
    }
    assert sm.get(BOARD, {"manager_id": "x"}).status_code == 400


@pytest.mark.django_db
def test_leaderboard_manager_filter_ignored_for_manager(world):
    m1 = _client(world["m1"])
    base = _board_ids(m1.get(BOARD, {"period": "day"}))
    assert _board_ids(m1.get(BOARD, {"period": "day", "manager_id": world["m2"].id})) == base
    assert world["op2"].id not in base


@pytest.mark.django_db
def test_dashboard_summary_manager_filter(world):
    root = _client(_mk_user("mf_root", Role.SUPERADMIN))
    full = root.get(SUMMARY, {"period": "day"}).data
    assert full["today"]["count"] == 3
    assert Decimal(full["turnover"]["actual"]) == Decimal("70000000")

    m1 = root.get(SUMMARY, {"period": "day", "manager_id": world["m1"].id}).data
    assert set(m1.keys()) == set(full.keys())
    assert m1["today"]["count"] == 1
    assert Decimal(m1["turnover"]["actual"]) == Decimal("10000000")
    assert [o["id"] for o in m1["top_operators"]] == [world["op1"].id]
    assert m1["shift"]["expected"] in (0, 1)  # воскресенье → 0

    pool = root.get(SUMMARY, {"period": "day", "manager_id": "none"}).data
    assert Decimal(pool["turnover"]["actual"]) == Decimal("40000000")

    # После фильтрованных запросов кэш без фильтра — по-прежнему глобальный.
    again = root.get(SUMMARY, {"period": "day"}).data
    assert again["today"]["count"] == 3
    assert root.get(SUMMARY, {"manager_id": "bad"}).status_code == 400


@pytest.mark.django_db
def test_dashboard_summary_manager_filter_ignored_for_manager(world):
    m1 = _client(world["m1"])
    a = m1.get(SUMMARY, {"period": "day"}).data
    b = m1.get(SUMMARY, {"period": "day", "manager_id": world["m2"].id}).data
    assert a["today"]["count"] == b["today"]["count"] == 3

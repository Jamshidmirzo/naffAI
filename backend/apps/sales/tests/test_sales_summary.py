"""
`/api/sales/summary/` — сводка «кто сколько продал / что продавали /
общая сумма» с теми же фильтрами, что и список /sales.
"""

from __future__ import annotations

import datetime as dt
from decimal import Decimal

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from apps.operators.models import Operator, OperatorStatus
from apps.catalog.models import Channel
from apps.sales.models import Sale, SaleOperator, SaleStatus
from apps.sales.selectors import sales_summary
from apps.users.models import Profile, Role

User = get_user_model()


@pytest.fixture
def ops(db):
    a = Operator.objects.create(full_name="Alice", status=OperatorStatus.ACTIVE)
    b = Operator.objects.create(full_name="Bob", status=OperatorStatus.ACTIVE)
    return a, b


@pytest.fixture(autouse=True)
def _channel(db):
    global _CH
    _CH = Channel.objects.create(name="Наличные")
    yield


def _sale(op, amount, model="iPhone 15", status=SaleStatus.CONFIRMED, sold_at=None, split=None):
    s = Sale.objects.create(
        imei=f"35{amount}",
        phone_model=model,
        amount=Decimal(amount),
        operator=op,
        channel=_CH,
        status=status,
        sold_at=sold_at or timezone.now(),
    )
    lines = split or [(op, amount)]
    for line_op, line_amount in lines:
        SaleOperator.objects.create(sale=s, operator=line_op, amount=Decimal(line_amount))
    return s


@pytest.mark.django_db
def test_summary_totals_and_by_operator(ops):
    a, b = ops
    _sale(a, 1000, model="iPhone 15")
    _sale(a, 2000, model="Samsung A05")
    _sale(b, 3000, model="iPhone 15")

    out = sales_summary()
    assert out["total_count"] == 3
    assert out["total_amount"] == Decimal(6000)
    by_op = {r["name"]: r for r in out["by_operator"]}
    assert by_op["Alice"]["count"] == 2 and by_op["Alice"]["amount"] == Decimal(3000)
    assert by_op["Bob"]["count"] == 1 and by_op["Bob"]["amount"] == Decimal(3000)
    by_model = {r["model"]: r for r in out["by_model"]}
    assert by_model["iPhone 15"]["count"] == 2
    assert by_model["Samsung A05"]["count"] == 1


@pytest.mark.django_db
def test_summary_split_sale_credits_each_share(ops):
    a, b = ops
    # Одна продажа 5000, сплит 2000/3000 — каждому его доля.
    _sale(a, 5000, split=[(a, 2000), (b, 3000)])
    out = sales_summary()
    assert out["total_count"] == 1
    assert out["total_amount"] == Decimal(5000)
    by_op = {r["name"]: r for r in out["by_operator"]}
    assert by_op["Alice"]["amount"] == Decimal(2000)
    assert by_op["Bob"]["amount"] == Decimal(3000)


@pytest.mark.django_db
def test_summary_excludes_pending_by_default(ops):
    a, _ = ops
    _sale(a, 1000)
    _sale(a, 9000, status=SaleStatus.PENDING)
    out = sales_summary()
    assert out["total_count"] == 1
    assert out["total_amount"] == Decimal(1000)


@pytest.mark.django_db
def test_summary_date_range_includes_last_day(ops):
    a, _ = ops
    tz = timezone.get_current_timezone()
    # Продажа 31 августа в 18:00 — bare date_to=2026-08-31 обязан её включить.
    _sale(a, 1500, sold_at=dt.datetime(2026, 8, 31, 18, 0, tzinfo=tz))

    mgr = User.objects.create_user(username="mgr", password="x")
    Profile.objects.create(user=mgr, role=Role.MANAGER)
    c = APIClient()
    c.force_authenticate(mgr)
    r = c.get("/api/sales/summary/", {"date_from": "2026-08-01", "date_to": "2026-08-31"})
    assert r.status_code == 200, r.content
    assert r.data["total_count"] == 1


@pytest.mark.django_db
def test_summary_operator_role_forbidden(ops):
    a, _ = ops
    u = User.objects.create_user(username="op1", password="x")
    Profile.objects.create(user=u, role=Role.OPERATOR, operator=a)
    c = APIClient()
    c.force_authenticate(u)
    r = c.get("/api/sales/summary/")
    assert r.status_code == 403

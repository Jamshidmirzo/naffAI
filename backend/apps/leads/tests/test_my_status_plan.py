"""
`/api/leads/my/status/` отдаёт `plan_target` / `plan_actual` за текущий
месяц (design-atlas V2, 2026-10-14) — тот же расчёт, что `plan_*` в
`/api/operators/`. Старые поля не меняются.
"""

from __future__ import annotations

from decimal import Decimal

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from apps.catalog.models import Channel
from apps.operators.models import Operator, OperatorMonthlyPlan, OperatorStatus
from apps.sales.models import Sale, SaleOperator
from apps.users.models import Profile, Role

User = get_user_model()


def _op_client(op):
    u = User.objects.create_user(username=f"plan_op{op.id}", password="x")
    Profile.objects.create(user=u, role=Role.OPERATOR, operator=op)
    c = APIClient()
    c.force_authenticate(u)
    return c


@pytest.mark.django_db
def test_my_status_plan_defaults():
    op = Operator.objects.create(full_name="Plan None", status=OperatorStatus.ACTIVE)
    body = _op_client(op).get("/api/leads/my/status/").data
    assert body["plan_target"] is None
    assert body["plan_actual"] == 0
    # Старые поля на месте.
    assert "working_count" in body and "reason_ru" in body


@pytest.mark.django_db
def test_my_status_plan_matches_operators_list():
    op = Operator.objects.create(full_name="Plan Op", status=OperatorStatus.ACTIVE)
    other = Operator.objects.create(full_name="Plan Other", status=OperatorStatus.ACTIVE)
    ch = Channel.objects.create(name="Telegram")
    today = timezone.localdate()
    OperatorMonthlyPlan.objects.create(
        operator=op, year=today.year, month=today.month, target_amount=Decimal("50000000")
    )
    for amount, status, op_ in (
        ("12000000", "confirmed", op),
        ("3000000", "pending", op),
        ("9000000", "confirmed", other),
    ):
        s = Sale.objects.create(
            imei="490154203237518", phone_model="X", operator=op_, channel=ch,
            amount=Decimal(amount), sold_at=timezone.now(), status=status,
        )
        SaleOperator.objects.create(sale=s, operator=op_, amount=Decimal(amount))

    body = _op_client(op).get("/api/leads/my/status/").data
    assert body["plan_target"] == 50000000
    assert body["plan_actual"] == 12000000

    mgr = User.objects.create_user(username="plan_root", password="x")
    Profile.objects.create(user=mgr, role=Role.SUPERADMIN)
    c = APIClient()
    c.force_authenticate(mgr)
    row = next(r for r in c.get("/api/operators/").data if r["id"] == op.id)
    assert Decimal(row["plan_target"]) == body["plan_target"]
    assert Decimal(row["plan_actual"]) == body["plan_actual"]

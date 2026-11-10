"""
Табло / «Top operatorlar»: фильтр по hamkor (partner_ids), календарный
диапазон с голыми датами и Excel-выгрузка с бонусом N%.
"""

from __future__ import annotations

import datetime as dt
from decimal import Decimal
from io import BytesIO

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from openpyxl import load_workbook
from rest_framework.test import APIClient

from apps.analytics.selectors import leaderboard
from apps.catalog.models import Channel
from apps.operators.models import Operator, OperatorStatus
from apps.sales.models import Sale, SaleOperator, SalePartner, SaleStatus
from apps.users.models import Profile, Role

User = get_user_model()


@pytest.fixture
def setup(db):
    anor = Channel.objects.create(name="Anor")
    tbc = Channel.objects.create(name="TBC")
    bonu = Operator.objects.create(full_name="Bonu", status=OperatorStatus.ACTIVE)
    zilola = Operator.objects.create(full_name="Zilola", status=OperatorStatus.ACTIVE)
    return anor, tbc, bonu, zilola


def _sale(op, amount, channel, *, partners=None, sold_at=None):
    s = Sale.objects.create(
        imei=f"35{amount}{op.id}",
        phone_model="iPhone 15",
        amount=Decimal(amount),
        operator=op,
        channel=channel,
        status=SaleStatus.CONFIRMED,
        sold_at=sold_at or timezone.now(),
    )
    SaleOperator.objects.create(sale=s, operator=op, amount=Decimal(amount))
    for partner, part in partners or []:
        SalePartner.objects.create(sale=s, partner=partner, amount=Decimal(part))
    return s


def _manager_client():
    mgr = User.objects.create_user(username="mgr", password="x")
    Profile.objects.create(user=mgr, role=Role.MANAGER)
    c = APIClient()
    c.force_authenticate(mgr)
    return c


@pytest.mark.django_db
def test_leaderboard_partner_filter(setup):
    anor, tbc, bonu, zilola = setup
    _sale(bonu, 1000, anor)
    _sale(bonu, 2000, tbc)
    # Split payment: primary channel TBC, part paid through Anor.
    _sale(zilola, 5000, tbc, partners=[(tbc, 3000), (anor, 2000)])

    rows = {r["operator_name"]: r for r in leaderboard(limit=None, partner_ids=[anor.id])}
    assert Decimal(rows["Bonu"]["total"]) == 1000 and rows["Bonu"]["count"] == 1
    assert rows["Zilola"]["count"] == 1

    rows = {r["operator_name"]: r for r in leaderboard(limit=None)}
    assert Decimal(rows["Bonu"]["total"]) == 3000


@pytest.mark.django_db
def test_leaderboard_bare_date_to_covers_whole_day(setup):
    anor, _, bonu, _ = setup
    late = timezone.make_aware(dt.datetime(2026, 11, 7, 18, 30))
    _sale(bonu, 1000, anor, sold_at=late)
    c = _manager_client()
    r = c.get("/api/analytics/leaderboard/", {"date_from": "2026-11-07", "date_to": "2026-11-07"})
    assert r.status_code == 200
    assert [row["operator_name"] for row in r.json()] == ["Bonu"]


@pytest.mark.django_db
def test_leaderboard_export_bonus(setup):
    anor, tbc, bonu, zilola = setup
    _sale(bonu, 190_045_000, anor)
    _sale(zilola, 64_560_000, tbc)
    c = _manager_client()
    r = c.get("/api/analytics/leaderboard/export.xlsx", {"percent": "3"})
    assert r.status_code == 200
    ws = load_workbook(BytesIO(r.content)).active
    rows = list(ws.iter_rows(values_only=True))
    assert rows[0] == ("№", "Operator", "Sotuvlar", "Savdo summasi", "Foiz", "Bonus")
    assert rows[1] == (1, "Bonu", 1, 190_045_000, "3%", 5_701_350)
    assert rows[2] == (2, "Zilola", 1, 64_560_000, "3%", 1_936_800)
    assert rows[3][1] == "JAMI"
    assert rows[3][3] == 254_605_000
    assert rows[3][5] == 7_638_150


@pytest.mark.django_db
def test_leaderboard_export_forbidden_for_operator(setup):
    _, _, bonu, _ = setup
    u = User.objects.create_user(username="op", password="x")
    Profile.objects.create(user=u, role=Role.OPERATOR, operator=bonu)
    c = APIClient()
    c.force_authenticate(u)
    r = c.get("/api/analytics/leaderboard/export.xlsx")
    assert r.status_code == 403

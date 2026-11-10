"""Галочка «OXS ga urildi» на продаже: отметка, снятие, фильтр списка."""

from __future__ import annotations

from decimal import Decimal

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from apps.audit.models import AuditLog
from apps.catalog.models import Channel
from apps.operators.models import Operator, OperatorStatus
from apps.sales.models import Sale, SaleOperator, SaleStatus
from apps.users.models import Profile, Role

User = get_user_model()


@pytest.fixture
def sale(db):
    op = Operator.objects.create(full_name="Bonu", status=OperatorStatus.ACTIVE)
    ch = Channel.objects.create(name="Anor")
    s = Sale.objects.create(
        imei="356000000000001",
        phone_model="iPhone 15",
        amount=Decimal(1000),
        operator=op,
        channel=ch,
        status=SaleStatus.CONFIRMED,
        sold_at=timezone.now(),
    )
    SaleOperator.objects.create(sale=s, operator=op, amount=Decimal(1000))
    return s


def _client(role=Role.MANAGER, operator=None):
    u = User.objects.create_user(username=f"u-{role}", password="x", first_name="Dostonbek")
    Profile.objects.create(user=u, role=role, operator=operator)
    c = APIClient()
    c.force_authenticate(u)
    return c


@pytest.mark.django_db
def test_mark_and_unmark(sale):
    c = _client()
    r = c.post(f"/api/sales/{sale.id}/oxs/", {"marked": True}, format="json")
    assert r.status_code == 200
    assert r.json()["oxs_marked_at"]
    assert r.json()["oxs_marked_by_name"] == "Dostonbek"

    listed = c.get("/api/sales/").json()["results"][0]
    assert listed["oxs_marked_at"] and listed["oxs_marked_by_name"] == "Dostonbek"

    r = c.post(f"/api/sales/{sale.id}/oxs/", {"marked": False}, format="json")
    assert r.status_code == 200
    assert r.json()["oxs_marked_at"] is None
    sale.refresh_from_db()
    assert sale.oxs_marked_at is None and sale.oxs_marked_by is None
    assert AuditLog.objects.filter(entity="sales.Sale", entity_id=str(sale.id)).count() == 2


@pytest.mark.django_db
def test_repeat_mark_keeps_first_stamp(sale):
    c = _client()
    first = c.post(f"/api/sales/{sale.id}/oxs/", {"marked": True}, format="json").json()
    again = c.post(f"/api/sales/{sale.id}/oxs/", {"marked": True}, format="json").json()
    assert first["oxs_marked_at"] == again["oxs_marked_at"]


@pytest.mark.django_db
def test_list_filter(sale):
    c = _client()
    assert c.get("/api/sales/", {"oxs": "false"}).json()["count"] == 1
    assert c.get("/api/sales/", {"oxs": "true"}).json()["count"] == 0
    c.post(f"/api/sales/{sale.id}/oxs/", {"marked": True}, format="json")
    assert c.get("/api/sales/", {"oxs": "true"}).json()["count"] == 1
    assert c.get("/api/sales/", {"oxs": "false"}).json()["count"] == 0


@pytest.mark.django_db
def test_operator_cannot_mark(sale):
    c = _client(role=Role.OPERATOR, operator=sale.operator)
    r = c.post(f"/api/sales/{sale.id}/oxs/", {"marked": True}, format="json")
    assert r.status_code == 403

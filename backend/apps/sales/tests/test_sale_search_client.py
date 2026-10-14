"""
`GET /api/sales/?search=` ищет ещё и по клиенту (design-atlas V2,
2026-10-14): `client_name` / `client_phone` (+ digits-only вариант для
номеров с разделителями). Старые поля поиска (imei / модель / оператор)
продолжают работать.
"""

from __future__ import annotations

from decimal import Decimal

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from apps.catalog.models import Channel
from apps.operators.models import Operator
from apps.sales.models import Sale
from apps.sales.selectors import sale_list
from apps.users.models import Profile, Role

User = get_user_model()


@pytest.fixture
def sales(db):
    op = Operator.objects.create(full_name="Seller Search", status="active")
    ch = Channel.objects.create(name="Telegram")

    def mk(imei, model, name, phone):
        return Sale.objects.create(
            imei=imei, phone_model=model, operator=op, channel=ch,
            amount=Decimal("1000000"), sold_at=timezone.now(), status="confirmed",
            client_name=name, client_phone=phone,
        )

    return {
        "jasur": mk("490154203237518", "iPhone 15", "Jasur Karimov", "+998901234567"),
        "dilnoza": mk("356938035643809", "Galaxy S24", "Dilnoza Aliyeva", "+998935550011"),
        "nobody": mk("353918058381690", "Redmi 13", "", ""),
    }


def _ids(qs) -> set[int]:
    return set(qs.values_list("id", flat=True))


@pytest.mark.django_db
def test_search_by_client_name(sales):
    assert _ids(sale_list(search="karimov")) == {sales["jasur"].id}


@pytest.mark.django_db
def test_search_by_client_phone_raw_and_formatted(sales):
    assert _ids(sale_list(search="93555")) == {sales["dilnoza"].id}
    assert _ids(sale_list(search="+998901234567")) == {sales["jasur"].id}
    # С разделителями — матчим по цифрам.
    assert _ids(sale_list(search="90 123-45-67")) == {sales["jasur"].id}


@pytest.mark.django_db
def test_legacy_search_fields_still_work(sales):
    assert _ids(sale_list(search="Galaxy")) == {sales["dilnoza"].id}
    assert _ids(sale_list(search="353918058")) == {sales["nobody"].id}
    assert _ids(sale_list(search="Seller Search")) == set(s.id for s in sales.values())


@pytest.mark.django_db
def test_search_via_api(sales):
    u = User.objects.create_user(username="sale_search_mgr", password="x")
    Profile.objects.create(user=u, role=Role.SUPERADMIN)
    c = APIClient()
    c.force_authenticate(u)
    resp = c.get("/api/sales/", {"search": "Dilnoza"})
    assert resp.status_code == 200, resp.data
    rows = resp.data["results"] if isinstance(resp.data, dict) else resp.data
    assert [r["id"] for r in rows] == [sales["dilnoza"].id]

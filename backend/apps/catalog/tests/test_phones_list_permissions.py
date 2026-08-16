"""
Operators need read-only access to the phone catalog so they can browse
models and copy quotes/photos to send clients from a chat conversation.
Writes stay senior-only (add / edit / delete phones, upload cover photos).

Regression guard: `WritesTeamLead` maps GET/HEAD/OPTIONS to
`IsAuthenticatedAnyRole` and everything else to `IsTeamLead`. If someone
tightens it back to team-lead-only, the operator's catalog page silently
403s and the copy-text/photo buttons stop working — this test file catches
that.
"""

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from apps.catalog.models import PhoneModel
from apps.operators.models import Operator
from apps.users.models import Profile, Role

User = get_user_model()

pytestmark = pytest.mark.django_db


@pytest.fixture
def api_client():
    return APIClient()


@pytest.fixture
def op_user(db):
    op = Operator.objects.create(full_name="Оператор Тест Каталог", status="active")
    user = User.objects.create_user(username="op_catalog", password="x")
    Profile.objects.create(user=user, role=Role.OPERATOR, operator=op)
    return user


@pytest.fixture
def tl_user(db):
    user = User.objects.create_user(username="tl_catalog", password="x")
    Profile.objects.create(user=user, role=Role.TEAM_LEAD)
    return user


@pytest.fixture
def phone(db):
    return PhoneModel.objects.create(
        brand="Apple",
        model_name="iPhone 15 Pro",
        storage_gb=256,
        ram_gb=8,
        price="17500000.00",
        stock_status="available",
        is_active=True,
    )


def test_operator_can_list_phones(api_client, op_user, phone):
    api_client.force_authenticate(op_user)
    r = api_client.get("/api/catalog/phones/")
    assert r.status_code == 200
    data = r.data.get("results", r.data)
    names = [p["model_name"] for p in data]
    assert "iPhone 15 Pro" in names


def test_operator_can_retrieve_phone(api_client, op_user, phone):
    api_client.force_authenticate(op_user)
    r = api_client.get(f"/api/catalog/phones/{phone.id}/")
    assert r.status_code == 200
    assert r.data["model_name"] == "iPhone 15 Pro"


def test_operator_can_get_phone_quote(api_client, op_user, phone):
    """Quote endpoint powers InstallmentPanel + copy buttons — must
    stay reachable for operators."""
    api_client.force_authenticate(op_user)
    r = api_client.get(f"/api/catalog/phones/{phone.id}/quote/?lang=uz")
    assert r.status_code == 200
    assert "text" in r.data
    assert "installments" in r.data


def test_operator_cannot_create_phone(api_client, op_user):
    api_client.force_authenticate(op_user)
    r = api_client.post(
        "/api/catalog/phones/",
        {
            "brand": "Samsung",
            "model_name": "Galaxy S25",
            "price": "12000000.00",
        },
        format="json",
    )
    assert r.status_code == 403
    assert not PhoneModel.objects.filter(model_name="Galaxy S25").exists()


def test_operator_cannot_patch_phone(api_client, op_user, phone):
    api_client.force_authenticate(op_user)
    r = api_client.patch(
        f"/api/catalog/phones/{phone.id}/",
        {"price": "1.00"},
        format="json",
    )
    assert r.status_code == 403
    phone.refresh_from_db()
    assert str(phone.price) == "17500000.00"


def test_operator_cannot_delete_phone(api_client, op_user, phone):
    api_client.force_authenticate(op_user)
    r = api_client.delete(f"/api/catalog/phones/{phone.id}/")
    assert r.status_code == 403
    assert PhoneModel.objects.filter(id=phone.id).exists()


def test_operator_cannot_upload_cover(api_client, op_user, phone):
    api_client.force_authenticate(op_user)
    # empty POST is enough — permission check fires before file validation
    r = api_client.post(f"/api/catalog/phones/{phone.id}/upload_photo/")
    assert r.status_code == 403


def test_operator_cannot_list_banks(api_client, op_user):
    """Banks CRUD stays senior-only — operator never touches this endpoint
    directly (installment matrix is served via /quote/)."""
    api_client.force_authenticate(op_user)
    r = api_client.get("/api/catalog/installment/banks/")
    assert r.status_code == 403


def test_tl_can_write_phone(api_client, tl_user):
    api_client.force_authenticate(tl_user)
    r = api_client.post(
        "/api/catalog/phones/",
        {
            "brand": "Xiaomi",
            "model_name": "14T Pro",
            "price": "8500000.00",
        },
        format="json",
    )
    assert r.status_code == 201
    assert PhoneModel.objects.filter(model_name="14T Pro").exists()


def test_anonymous_denied(api_client, phone):
    r = api_client.get("/api/catalog/phones/")
    assert r.status_code in (401, 403)

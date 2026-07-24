import pytest
from decimal import Decimal
from django.utils import timezone
from rest_framework.test import APIClient
from django.contrib.auth import get_user_model
from apps.users.models import Profile, Role
from apps.catalog.models import Channel, TacLookup
from apps.operators.models import Operator
from apps.sales.models import Sale

User = get_user_model()
pytestmark = pytest.mark.django_db


@pytest.fixture
def tl_client(db):
    u = User.objects.create_user(username="tl", password="x")
    Profile.objects.create(user=u, role=Role.TEAM_LEAD)
    client = APIClient()
    client.force_authenticate(user=u)
    return client


@pytest.fixture
def operator(db):
    return Operator.objects.create(full_name="Test", status="active")


@pytest.fixture
def channel(db):
    return Channel.objects.create(name="Telegram")


def _make_sale(*, imei, phone_model, operator, channel, amount):
    return Sale.objects.create(
        imei=imei,
        phone_model=phone_model,
        operator=operator,
        channel=channel,
        amount=Decimal(amount),
        sold_at=timezone.now(),
    )


def test_suggest_from_sales(tl_client, operator, channel):
    for _ in range(3):
        _make_sale(imei="123456789012345", phone_model="iPhone 13", operator=operator, channel=channel, amount="1000")
    for _ in range(2):
        _make_sale(imei="123456789012346", phone_model="iPhone 12", operator=operator, channel=channel, amount="900")
    _make_sale(imei="123456789012347", phone_model="Galaxy S22", operator=operator, channel=channel, amount="800")

    response = tl_client.get("/api/imei/models/")
    assert response.status_code == 200

    results = str(response.json())
    assert "iPhone 13" in results
    assert "iPhone 12" in results
    assert "Galaxy S22" in results


def test_suggest_fallback_to_tac(tl_client):
    TacLookup.objects.create(tac="11111111", brand="Apple", model="iPhone 15")

    response = tl_client.get("/api/imei/models/")
    assert response.status_code == 200
    assert "iPhone 15" in str(response.json())


def test_suggest_filter_by_query(tl_client, operator, channel):
    _make_sale(imei="123456789012345", phone_model="iPhone 13", operator=operator, channel=channel, amount="1000")
    _make_sale(imei="123456789012347", phone_model="Galaxy S22", operator=operator, channel=channel, amount="800")

    response = tl_client.get("/api/imei/models/?q=iphone")
    assert response.status_code == 200
    results = str(response.json())
    assert "iPhone 13" in results
    assert "Galaxy S22" not in results

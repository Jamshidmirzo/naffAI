"""
GET /api/channels/ must be accessible to operators too — they need it to
populate the "channel of payment" dropdown on the "New sale" form (see
`OperatorSaleCreate.tsx`). POST/PATCH remain restricted to seniors.

Regression: before this fix, `permission_classes = [IsTeamLeadOrManagerReadOnly]`
covered every method, so an operator got 403 on GET → empty dropdown →
they could never submit a sale (canSubmit stayed false because channelId
was null).
"""

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from apps.catalog.models import Channel
from apps.operators.models import Operator
from apps.users.models import Profile, Role

User = get_user_model()

pytestmark = pytest.mark.django_db


@pytest.fixture
def api_client():
    return APIClient()


@pytest.fixture
def op_user(db):
    op = Operator.objects.create(full_name="Оператор Тест", status="active")
    user = User.objects.create_user(username="op_ch", password="x")
    Profile.objects.create(user=user, role=Role.OPERATOR, operator=op)
    return user


@pytest.fixture
def tl_user(db):
    user = User.objects.create_user(username="tl_ch", password="x")
    Profile.objects.create(user=user, role=Role.TEAM_LEAD)
    return user


@pytest.fixture
def channels(db):
    active = Channel.objects.create(name="Naqd", is_active=True)
    inactive = Channel.objects.create(name="Разобранный банк", is_active=False)
    return active, inactive


def test_operator_can_list_channels(api_client, op_user, channels):
    api_client.force_authenticate(op_user)
    r = api_client.get("/api/channels/")
    assert r.status_code == 200
    names = [row["name"] for row in r.data["results"]]
    # Operator only sees active partners (deactivated ones are hidden so
    # they can't accidentally submit a sale against a retired bank).
    assert "Naqd" in names
    assert "Разобранный банк" not in names


def test_operator_cannot_create_channel(api_client, op_user):
    api_client.force_authenticate(op_user)
    r = api_client.post("/api/channels/", {"name": "SomeBank"}, format="json")
    # POST still restricted to seniors — operator gets 403.
    assert r.status_code == 403
    assert not Channel.objects.filter(name="SomeBank").exists()


def test_tl_sees_all_channels_incl_inactive(api_client, tl_user, channels):
    api_client.force_authenticate(tl_user)
    r = api_client.get("/api/channels/")
    assert r.status_code == 200
    names = [row["name"] for row in r.data["results"]]
    assert "Naqd" in names
    assert "Разобранный банк" in names


def test_anonymous_still_denied(api_client, channels):
    r = api_client.get("/api/channels/")
    assert r.status_code in (401, 403)

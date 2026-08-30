import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from apps.operators.models import Operator
from apps.users.models import Profile, Role

User = get_user_model()


@pytest.fixture
def api_client():
    return APIClient()


@pytest.fixture
def op1(db):
    return Operator.objects.create(full_name="Оп Один", status="active")


@pytest.fixture
def op2(db):
    return Operator.objects.create(full_name="Оп Два", status="active")


@pytest.fixture
def user1(db, op1):
    u = User.objects.create_user(username="op1", password="x")
    Profile.objects.create(user=u, role=Role.OPERATOR, operator=op1)
    return u


@pytest.fixture
def user2(db, op2):
    u = User.objects.create_user(username="op2", password="x")
    Profile.objects.create(user=u, role=Role.OPERATOR, operator=op2)
    return u


@pytest.fixture
def manager(db):
    u = User.objects.create_user(username="mgr", password="x")
    Profile.objects.create(user=u, role=Role.MANAGER)
    return u

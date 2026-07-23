import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from apps.operators.models import Operator
from apps.users.models import Profile, Role
from apps.users.services import account_create_for_operator

User = get_user_model()


def _make(user, role, operator=None):
    Profile.objects.create(user=user, role=role, operator=operator)


@pytest.fixture
def api():
    return APIClient()


@pytest.fixture
def manager(db):
    u = User.objects.create_user(username="mgr", password="mgrpass1")
    _make(u, Role.MANAGER)
    return u


@pytest.fixture
def team_lead(db):
    u = User.objects.create_user(username="lead", password="leadpass1")
    _make(u, Role.TEAM_LEAD)
    return u


@pytest.fixture
def operator(db):
    return Operator.objects.create(full_name="Op", phone="+998901234567", status="active")


@pytest.fixture
def op_user(db, manager, operator):
    user, _ = account_create_for_operator(operator=operator, actor=manager)
    return user


@pytest.mark.django_db
def test_operator_cannot_call_admin_endpoints(api, op_user, operator):
    api.force_authenticate(op_user)
    r = api.post(f"/api/operators/{operator.id}/account/password/")
    assert r.status_code == 403 or r.status_code == 405
    r = api.get(f"/api/operators/{operator.id}/account/password/")
    assert r.status_code == 403


@pytest.mark.django_db
def test_team_lead_cannot_call_admin_endpoints(api, team_lead, operator):
    api.force_authenticate(team_lead)
    r = api.post(f"/api/operators/{operator.id}/account/", {"password": "newpass12"}, format="json")
    assert r.status_code == 403


@pytest.mark.django_db
def test_manager_can_create_and_view(api, manager, operator):
    api.force_authenticate(manager)
    r = api.post(f"/api/operators/{operator.id}/account/", {}, format="json")
    assert r.status_code == 201, r.content
    plain = r.data["password"]
    r2 = api.get(f"/api/operators/{operator.id}/account/password/")
    assert r2.status_code == 200
    assert r2.data["password"] == plain


@pytest.mark.django_db
def test_self_change_password_endpoint_available_to_any_role(api, op_user):
    # first login to know the plain — instead, set a known one
    op_user.set_password("known-one-1")
    op_user.save()
    api.force_authenticate(op_user)
    r = api.post(
        "/api/me/change-password/",
        {"old_password": "known-one-1", "new_password": "known-two-2"},
        format="json",
    )
    assert r.status_code == 200, r.content


@pytest.mark.django_db
def test_unauthenticated_login_normalizes_phone(api, manager, operator):
    api.force_authenticate(manager)
    r = api.post(f"/api/operators/{operator.id}/account/", {"password": "loginpass1"}, format="json")
    assert r.status_code == 201

    api.force_authenticate(user=None)
    # login using un-normalized phone
    r2 = api.post(
        "/api/auth/login/",
        {"username": "998901234567", "password": "loginpass1"},
        format="json",
    )
    assert r2.status_code == 200, r2.content
    assert r2.data["role"] == "operator"

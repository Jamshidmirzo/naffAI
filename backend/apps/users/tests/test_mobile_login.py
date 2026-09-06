"""
Tests for the mobile JWT login surface.

Covers:
  - Happy path: operator logs in by phone → 200 + access/refresh + me.
  - Wrong password → 401.
  - Inactive user → 401.
  - Non-operator (manager) → 200 (login is role-agnostic; operator-only
    endpoints enforce IsOperator downstream).
"""

from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from apps.operators.models import Operator
from apps.users.models import Profile, Role
from apps.users.services import account_create_for_operator

User = get_user_model()


@pytest.fixture
def api() -> APIClient:
    return APIClient()


@pytest.fixture
def manager(db):
    u = User.objects.create_user(username="mgr", password="mgrpass1")
    Profile.objects.create(user=u, role=Role.MANAGER)
    return u


@pytest.fixture
def operator(db):
    return Operator.objects.create(
        full_name="Op Test", phone="+998900000123", status="active"
    )


@pytest.fixture
def op_user(db, manager, operator):
    user, plain = account_create_for_operator(
        operator=operator, actor=manager, plain="opsecret1"
    )
    return user, plain


@pytest.mark.django_db
def test_mobile_login_ok(api, op_user, operator):
    _, plain = op_user
    r = api.post(
        "/api/auth/mobile-login/",
        {"phone": operator.phone, "password": plain},
        format="json",
    )
    assert r.status_code == 200, r.content
    body = r.json()
    assert body["access"]
    assert body["refresh"]
    assert body["role"] == Role.OPERATOR
    assert body["operator"] is not None
    assert body["operator"]["id"] == operator.id
    assert body["sip_credentials"] is None  # not provisioned yet


@pytest.mark.django_db
def test_mobile_login_bad_password(api, op_user, operator):
    r = api.post(
        "/api/auth/mobile-login/",
        {"phone": operator.phone, "password": "nope"},
        format="json",
    )
    assert r.status_code == 401


@pytest.mark.django_db
def test_mobile_login_manager_can_login(api, manager):
    r = api.post(
        "/api/auth/mobile-login/",
        {"phone": "mgr", "password": "mgrpass1"},
        format="json",
    )
    assert r.status_code == 200
    body = r.json()
    assert body["role"] == Role.MANAGER
    assert body["operator"] is None


@pytest.mark.django_db
def test_mobile_login_inactive_user(api, op_user, operator):
    user, plain = op_user
    user.is_active = False
    user.save(update_fields=["is_active"])
    r = api.post(
        "/api/auth/mobile-login/",
        {"phone": operator.phone, "password": plain},
        format="json",
    )
    assert r.status_code == 401


@pytest.mark.django_db
def test_mobile_refresh(api, op_user, operator):
    _, plain = op_user
    r = api.post(
        "/api/auth/mobile-login/",
        {"phone": operator.phone, "password": plain},
        format="json",
    )
    assert r.status_code == 200
    refresh = r.json()["refresh"]

    r2 = api.post(
        "/api/auth/mobile-refresh/", {"refresh": refresh}, format="json"
    )
    assert r2.status_code == 200, r2.content
    assert r2.json()["access"]


@pytest.mark.django_db
def test_mobile_refresh_invalid(api):
    r = api.post(
        "/api/auth/mobile-refresh/", {"refresh": "garbage"}, format="json"
    )
    assert r.status_code == 401


@pytest.mark.django_db
def test_mobile_login_sip_credentials_returned_when_set(api, op_user, operator):
    _, plain = op_user
    operator.sip_username = "6001"
    operator.sip_password = "sippw"
    operator.save(update_fields=["sip_username", "sip_password"])
    r = api.post(
        "/api/auth/mobile-login/",
        {"phone": operator.phone, "password": plain},
        format="json",
    )
    assert r.status_code == 200
    creds = r.json()["sip_credentials"]
    assert creds is not None
    assert creds["username"] == "6001"
    assert creds["password"] == "sippw"

"""Guards around Profile.preferred_language + related endpoints.

- Default is 'uz' (phone-shop team is UZ-first).
- MeApi exposes it.
- Manager can PATCH other users' language via /users/{id}/ and
  /operators/{id}/account/language/.
- Operators can flip their own via PATCH /me/.
- Operators cannot flip someone else's.
"""

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
def op(db):
    return Operator.objects.create(full_name="Оп", status="active", phone="+998900000010")


@pytest.fixture
def operator_user(db, op):
    u = User.objects.create_user(username="+998900000010", password="x")
    Profile.objects.create(user=u, role=Role.OPERATOR, operator=op)
    return u


@pytest.fixture
def manager(db):
    u = User.objects.create_user(username="mgr", password="x")
    Profile.objects.create(user=u, role=Role.MANAGER)
    return u


@pytest.mark.django_db
def test_profile_default_language_is_uz(operator_user):
    assert operator_user.profile.preferred_language == "uz"


@pytest.mark.django_db
def test_me_endpoint_exposes_preferred_language(api_client, operator_user):
    api_client.force_authenticate(operator_user)
    r = api_client.get("/api/auth/me/")
    assert r.status_code == 200
    assert r.json()["preferred_language"] == "uz"


@pytest.mark.django_db
def test_operator_can_change_own_language(api_client, operator_user):
    api_client.force_authenticate(operator_user)
    r = api_client.patch("/api/auth/me/", {"preferred_language": "ru"}, format="json")
    assert r.status_code == 200
    operator_user.profile.refresh_from_db()
    assert operator_user.profile.preferred_language == "ru"


@pytest.mark.django_db
def test_operator_cannot_change_others_language_via_users_patch(api_client, operator_user, manager):
    # Operators shouldn't reach the manager admin surface at all.
    api_client.force_authenticate(operator_user)
    r = api_client.patch(
        f"/api/users/{manager.id}/", {"preferred_language": "ru"}, format="json"
    )
    assert r.status_code == 403


@pytest.mark.django_db
def test_manager_can_change_operator_language_via_operator_endpoint(
    api_client, manager, op, operator_user
):
    api_client.force_authenticate(manager)
    r = api_client.patch(
        f"/api/operators/{op.id}/account/language/",
        {"preferred_language": "ru"},
        format="json",
    )
    assert r.status_code == 200, r.content
    operator_user.profile.refresh_from_db()
    assert operator_user.profile.preferred_language == "ru"


@pytest.mark.django_db
def test_manager_can_change_other_users_language_via_users_endpoint(api_client, manager):
    # A second web-only account (no operator).
    other = User.objects.create_user(username="mgr2", password="x")
    Profile.objects.create(user=other, role=Role.MANAGER)

    api_client.force_authenticate(manager)
    r = api_client.patch(
        f"/api/users/{other.id}/", {"preferred_language": "ru"}, format="json"
    )
    assert r.status_code == 200
    other.profile.refresh_from_db()
    assert other.profile.preferred_language == "ru"


@pytest.mark.django_db
def test_invalid_language_rejected(api_client, operator_user):
    api_client.force_authenticate(operator_user)
    r = api_client.patch("/api/auth/me/", {"preferred_language": "fr"}, format="json")
    assert r.status_code == 400

"""Свой порядок пунктов бокового меню: /api/auth/me/ nav_order."""

from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from apps.users.models import Profile, Role

User = get_user_model()


@pytest.fixture
def client(db):
    u = User.objects.create_user(username="dostik", password="x")
    Profile.objects.create(user=u, role=Role.SUPER_MANAGER)
    c = APIClient()
    c.force_authenticate(u)
    return c


@pytest.mark.django_db
def test_default_is_empty(client):
    assert client.get("/api/auth/me/").json()["nav_order"] == []


@pytest.mark.django_db
def test_save_and_read_back(client):
    order = ["/sales", "h:analytics", "/analytics", "/sales"]
    r = client.patch("/api/auth/me/", {"nav_order": order}, format="json")
    assert r.status_code == 200
    # Duplicates collapse, first position wins.
    assert r.json()["nav_order"] == ["/sales", "h:analytics", "/analytics"]
    assert client.get("/api/auth/me/").json()["nav_order"] == ["/sales", "h:analytics", "/analytics"]

    r = client.patch("/api/auth/me/", {"nav_order": []}, format="json")
    assert r.status_code == 200
    assert client.get("/api/auth/me/").json()["nav_order"] == []


@pytest.mark.django_db
def test_rejects_garbage(client):
    r = client.patch("/api/auth/me/", {"nav_order": "nope"}, format="json")
    assert r.status_code == 400
    r = client.patch("/api/auth/me/", {"nav_order": [1, 2]}, format="json")
    assert r.status_code == 400

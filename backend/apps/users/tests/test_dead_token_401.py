"""
A dead token must answer 401, not 403 (2026-10-17).

With SessionAuthentication first DRF had no WWW-Authenticate header and
turned «not authenticated» into 403; the SPA only logs out on 401, so a
tab with a deleted token (check-out deletes it) stayed and toasted
«Доступ запрещён» on every poll.
"""

from __future__ import annotations

import pytest
from django.contrib.auth.models import User
from rest_framework.authtoken.models import Token
from rest_framework.test import APIClient


@pytest.mark.django_db
def test_unknown_token_is_401():
    r = APIClient().get("/api/auth/me/", HTTP_AUTHORIZATION="Token deadbeef")
    assert r.status_code == 401
    assert r["WWW-Authenticate"].startswith("Token")


@pytest.mark.django_db
def test_no_credentials_is_401():
    assert APIClient().get("/api/auth/me/").status_code == 401


@pytest.mark.django_db
def test_deleted_token_is_401_and_live_token_works():
    user = User.objects.create_user(username="u1", password="x")
    token = Token.objects.create(user=user)
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Token {token.key}")
    assert client.get("/api/auth/me/").status_code == 200
    token.delete()
    assert client.get("/api/auth/me/").status_code == 401

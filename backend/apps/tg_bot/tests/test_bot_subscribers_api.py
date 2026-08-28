"""
Manager-side API for `BotSubscription`:

  GET   /api/bot/subscribers/       — full list, sorted by receives_broadcasts
                                       DESC then last_seen_at DESC
  PATCH /api/bot/subscribers/{id}/  — toggle `receives_broadcasts` and/or
                                       edit `phone` (re-runs the operator
                                       auto-link)

Both endpoints are manager-only (IsTeamLead). Operator role → 403.
"""

from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from apps.operators.models import Operator
from apps.tg_bot.models import BotSubscription
from apps.users.models import Profile, Role

User = get_user_model()


@pytest.fixture
def manager_user(db):
    user = User.objects.create_user(username="mgr", password="testpass")
    profile, _ = Profile.objects.get_or_create(user=user)
    profile.role = Role.MANAGER
    profile.save()
    return user


@pytest.fixture
def operator_user(db):
    op = Operator.objects.create(full_name="Op1", status="active")
    user = User.objects.create_user(username="op1", password="testpass")
    profile, _ = Profile.objects.get_or_create(user=user)
    profile.role = Role.OPERATOR
    profile.operator = op
    profile.save()
    return user


@pytest.fixture
def subscriptions(db):
    """Seed 3 subs — one broadcast-on, one broadcast-off, one blocked."""
    on = BotSubscription.objects.create(
        chat_id=1001,
        chat_title="Manager Ivan",
        is_active=True,
        language="ru",
        receives_broadcasts=True,
    )
    off = BotSubscription.objects.create(
        chat_id=1002,
        chat_title="Operator Dilafruz",
        is_active=True,
        language="uz",
        receives_broadcasts=False,
    )
    blocked = BotSubscription.objects.create(
        chat_id=1003,
        chat_title="Blocked",
        is_active=True,
        language="ru",
        receives_broadcasts=True,
    )
    from django.utils import timezone

    blocked.blocked_at = timezone.now()
    blocked.save(update_fields=["blocked_at"])
    return {"on": on, "off": off, "blocked": blocked}


@pytest.mark.django_db
def test_list_returns_all_subs_including_blocked(manager_user, subscriptions):
    client = APIClient()
    client.force_authenticate(user=manager_user)
    r = client.get("/api/bot/subscribers/")
    assert r.status_code == 200
    data = r.json()
    assert data["count"] == 3
    chat_ids = {row["chat_id"] for row in data["results"]}
    assert chat_ids == {1001, 1002, 1003}


@pytest.mark.django_db
def test_list_sorted_broadcasts_first(manager_user, subscriptions):
    client = APIClient()
    client.force_authenticate(user=manager_user)
    r = client.get("/api/bot/subscribers/")
    results = r.json()["results"]
    # First two rows have receives_broadcasts=True; last row is the off one.
    on_flags = [row["receives_broadcasts"] for row in results]
    assert on_flags[0] is True
    assert on_flags[-1] is False


@pytest.mark.django_db
def test_operator_forbidden(operator_user, subscriptions):
    client = APIClient()
    client.force_authenticate(user=operator_user)
    r = client.get("/api/bot/subscribers/")
    assert r.status_code == 403


@pytest.mark.django_db
def test_anon_forbidden(subscriptions):
    client = APIClient()
    r = client.get("/api/bot/subscribers/")
    assert r.status_code in (401, 403)


@pytest.mark.django_db
def test_patch_toggle_broadcast_off(manager_user, subscriptions):
    client = APIClient()
    client.force_authenticate(user=manager_user)
    sub = subscriptions["on"]
    r = client.patch(
        f"/api/bot/subscribers/{sub.id}/",
        {"receives_broadcasts": False},
        format="json",
    )
    assert r.status_code == 200
    assert r.json()["receives_broadcasts"] is False
    sub.refresh_from_db()
    assert sub.receives_broadcasts is False


@pytest.mark.django_db
def test_patch_toggle_broadcast_on(manager_user, subscriptions):
    client = APIClient()
    client.force_authenticate(user=manager_user)
    sub = subscriptions["off"]
    r = client.patch(
        f"/api/bot/subscribers/{sub.id}/",
        {"receives_broadcasts": True},
        format="json",
    )
    assert r.status_code == 200
    assert r.json()["receives_broadcasts"] is True


@pytest.mark.django_db
def test_patch_operator_forbidden(operator_user, subscriptions):
    client = APIClient()
    client.force_authenticate(user=operator_user)
    r = client.patch(
        f"/api/bot/subscribers/{subscriptions['on'].id}/",
        {"receives_broadcasts": False},
        format="json",
    )
    assert r.status_code == 403


@pytest.mark.django_db
def test_patch_phone_relinks_operator(manager_user, subscriptions):
    """Editing phone re-runs the auto-link resolver."""
    op = Operator.objects.create(full_name="Bonu", status="active", phone="+998901234567")
    client = APIClient()
    client.force_authenticate(user=manager_user)
    sub = subscriptions["on"]
    r = client.patch(
        f"/api/bot/subscribers/{sub.id}/",
        {"phone": "+998 90 123 45 67"},
        format="json",
    )
    assert r.status_code == 200
    body = r.json()
    assert body["phone"] == "+998901234567"
    assert body["linked_operator"] is not None
    assert body["linked_operator"]["id"] == op.id


@pytest.mark.django_db
def test_patch_unknown_id_404(manager_user):
    client = APIClient()
    client.force_authenticate(user=manager_user)
    r = client.patch("/api/bot/subscribers/99999/", {"receives_broadcasts": True}, format="json")
    assert r.status_code == 404

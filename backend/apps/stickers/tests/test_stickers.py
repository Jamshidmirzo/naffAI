"""
F1 — Operator sticker service + API tests.

Covers:
- Regular emoji uniqueness across operators.
- Rare sticker singleton behaviour (previous holder is demoted).
- Permission: only admins can grant rare; operator can set own regular.
- Palette endpoint reports current taken map and the rare holder.
"""

from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model
from rest_framework.exceptions import ValidationError
from rest_framework.test import APIClient

from apps.operators.models import Operator
from apps.stickers.models import OperatorSticker
from apps.stickers.services import (
    ALLOWED_COMMON_EMOJIS,
    sticker_grant_rare,
    sticker_revoke,
    sticker_set,
)
from apps.users.models import Profile, Role
from apps.users.services import account_create_for_operator

User = get_user_model()

E1 = ALLOWED_COMMON_EMOJIS[0]  # "🔥"
E2 = ALLOWED_COMMON_EMOJIS[1]  # "⚡"


@pytest.fixture
def op1(db):
    return Operator.objects.create(
        full_name="Оператор Один", phone="+998901000001", status="active"
    )


@pytest.fixture
def op2(db):
    return Operator.objects.create(
        full_name="Оператор Два", phone="+998901000002", status="active"
    )


@pytest.fixture
def manager(db):
    u = User.objects.create_user(username="mgr-sticker", password="mgr-pass1")
    Profile.objects.create(user=u, role=Role.MANAGER)
    return u


@pytest.fixture
def team_lead(db):
    u = User.objects.create_user(username="lead-sticker", password="lead-pass1")
    Profile.objects.create(user=u, role=Role.TEAM_LEAD)
    return u


@pytest.fixture
def op1_user(db, op1, manager):
    user, _ = account_create_for_operator(operator=op1, actor=manager)
    return user


@pytest.fixture
def api():
    return APIClient()


@pytest.mark.django_db
def test_common_sticker_uniqueness(op1, op2):
    sticker_set(operator=op1, emoji=E1)
    with pytest.raises(ValidationError):
        sticker_set(operator=op2, emoji=E1)


@pytest.mark.django_db
def test_common_sticker_update_same_operator(op1):
    sticker_set(operator=op1, emoji=E1)
    sticker_set(operator=op1, emoji=E2)
    row = OperatorSticker.objects.get(operator=op1)
    assert row.emoji == E2


@pytest.mark.django_db
def test_common_sticker_reject_non_palette(op1):
    with pytest.raises(ValidationError):
        sticker_set(operator=op1, emoji="not_in_palette")


@pytest.mark.django_db
def test_rare_sticker_singleton_replaces_previous(op1, op2, team_lead):
    sticker_grant_rare(operator=op1, emoji="👑", actor=team_lead)
    assert OperatorSticker.objects.filter(is_rare=True).count() == 1
    # Reassign — op1 must lose their row entirely, op2 gets the rare.
    sticker_grant_rare(operator=op2, emoji="👑", actor=team_lead)
    assert OperatorSticker.objects.filter(is_rare=True).count() == 1
    holder = OperatorSticker.objects.get(is_rare=True)
    assert holder.operator_id == op2.id
    assert not OperatorSticker.objects.filter(operator=op1).exists()


@pytest.mark.django_db
def test_taken_endpoint_returns_current_emojis(api, op1, op2, team_lead):
    api.force_authenticate(team_lead)
    sticker_set(operator=op1, emoji=E1)
    sticker_grant_rare(operator=op2, emoji="👑", actor=team_lead)
    r = api.get("/api/stickers/palette/")
    assert r.status_code == 200
    payload = r.json()
    taken_emojis = {row["emoji"] for row in payload["taken"]}
    assert E1 in taken_emojis
    assert payload["rare"]["emoji"] == "👑"
    assert payload["rare"]["operator_id"] == op2.id
    # Palette contains the whole allowed list.
    assert len(payload["palette"]) == len(ALLOWED_COMMON_EMOJIS)


@pytest.mark.django_db
def test_only_admin_can_grant_rare_via_api(api, op1, op1_user, op2, manager):
    """Regular operators cannot use the admin `/operators/{id}/sticker/` route."""
    api.force_authenticate(op1_user)
    r = api.put(
        f"/api/operators/{op2.id}/sticker/",
        {"emoji": "👑", "is_rare": True},
        format="json",
    )
    assert r.status_code == 403


@pytest.mark.django_db
def test_operator_sets_own_sticker_via_me(api, op1_user, op1):
    api.force_authenticate(op1_user)
    r = api.put("/api/me/sticker/", {"emoji": E1}, format="json")
    assert r.status_code == 200, r.content
    assert r.json()["emoji"] == E1
    assert OperatorSticker.objects.get(operator=op1).emoji == E1


@pytest.mark.django_db
def test_admin_revoke_sticker(api, op1, manager):
    sticker_set(operator=op1, emoji=E1)
    api.force_authenticate(manager)
    r = api.delete(f"/api/operators/{op1.id}/sticker/")
    assert r.status_code == 204
    assert not OperatorSticker.objects.filter(operator=op1).exists()


@pytest.mark.django_db
def test_sticker_revoke_service_noop_when_missing(op1):
    # Should not raise even though op1 has nothing to revoke.
    sticker_revoke(operator=op1)
    assert not OperatorSticker.objects.filter(operator=op1).exists()

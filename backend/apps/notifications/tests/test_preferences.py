"""
Notification preferences (design-atlas V2, 2026-10-14).

  * GET/PATCH /api/notifications/preferences/ — формат, defaults, kind'ы
    по роли, 400 на чужой kind, права;
  * `notification_broadcast` пропускает получателей с in_app=False;
  * birthday_notify уважает in_app=False;
  * super_manager получает sale_created и birthday (пункт 3).
"""

from __future__ import annotations

import datetime as dt
from decimal import Decimal
from io import StringIO
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from django.core.management import call_command
from rest_framework.test import APIClient

from apps.catalog.models import Channel
from apps.notifications.models import Notification, NotificationKind, NotificationPreference
from apps.notifications.selectors import (
    OPERATOR_PREFERENCE_KINDS,
    SENIOR_PREFERENCE_KINDS,
)
from apps.notifications.services import notification_broadcast
from apps.operators.models import Operator
from apps.users.models import Profile, Role

User = get_user_model()

URL = "/api/notifications/preferences/"


def _mk_user(username: str, role: str, **profile) -> User:
    u = User.objects.create_user(username=username, password="x")
    Profile.objects.create(user=u, role=role, **profile)
    return u


def _client(user) -> APIClient:
    c = APIClient()
    c.force_authenticate(user)
    return c


# ---------------------------------------------------------------------------
# GET / PATCH
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_get_defaults_for_manager():
    mgr = _mk_user("np_mgr", Role.MANAGER)
    resp = _client(mgr).get(URL)
    assert resp.status_code == 200
    assert [i["kind"] for i in resp.data["items"]] == [str(k) for k in SENIOR_PREFERENCE_KINDS]
    assert all(i == {"kind": i["kind"], "in_app": True, "telegram": False} for i in resp.data["items"])


@pytest.mark.django_db
def test_get_kinds_for_operator_and_super_manager():
    op = Operator.objects.create(full_name="NP Op", status="active")
    op_user = _mk_user("np_op", Role.OPERATOR, operator=op)
    kinds = [i["kind"] for i in _client(op_user).get(URL).data["items"]]
    assert kinds == [str(k) for k in OPERATOR_PREFERENCE_KINDS]
    assert "snapshot_request" not in kinds

    sm = _mk_user("np_sm", Role.SUPER_MANAGER)
    kinds = [i["kind"] for i in _client(sm).get(URL).data["items"]]
    assert "sale_created" in kinds and "birthday" in kinds


@pytest.mark.django_db
def test_patch_updates_and_returns_full_list():
    mgr = _mk_user("np_mgr2", Role.MANAGER)
    c = _client(mgr)
    resp = c.patch(
        URL,
        {"items": [{"kind": "sale_created", "in_app": False}, {"kind": "birthday", "telegram": True}]},
        format="json",
    )
    assert resp.status_code == 200, resp.data
    by_kind = {i["kind"]: i for i in resp.data["items"]}
    assert by_kind["sale_created"] == {"kind": "sale_created", "in_app": False, "telegram": False}
    assert by_kind["birthday"] == {"kind": "birthday", "in_app": True, "telegram": True}
    assert by_kind["system"]["in_app"] is True
    assert NotificationPreference.objects.filter(user=mgr).count() == 2

    # Partial PATCH не трогает непереданные флаги.
    resp = c.patch(URL, {"items": [{"kind": "birthday", "in_app": False}]}, format="json")
    by_kind = {i["kind"]: i for i in resp.data["items"]}
    assert by_kind["birthday"] == {"kind": "birthday", "in_app": False, "telegram": True}
    # GET отражает то же.
    assert {i["kind"]: i for i in c.get(URL).data["items"]} == by_kind


@pytest.mark.django_db
def test_patch_rejects_kind_not_for_role():
    mgr = _mk_user("np_mgr3", Role.MANAGER)
    resp = _client(mgr).patch(
        URL, {"items": [{"kind": "sale_celebration", "in_app": False}]}, format="json"
    )
    assert resp.status_code == 400
    assert not NotificationPreference.objects.exists()

    resp = _client(mgr).patch(URL, {"items": [{"kind": "snapshot_request"}]}, format="json")
    assert resp.status_code == 400


@pytest.mark.django_db
def test_preferences_requires_auth():
    assert APIClient().get(URL).status_code in (401, 403)


# ---------------------------------------------------------------------------
# Broadcast filtering
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_broadcast_skips_muted_recipients():
    a = _mk_user("np_a", Role.MANAGER)
    b = _mk_user("np_b", Role.MANAGER)
    c = _mk_user("np_c", Role.MANAGER)
    NotificationPreference.objects.create(user=b, kind="sale_created", in_app=False)
    # Отключение ДРУГОГО kind'а не влияет.
    NotificationPreference.objects.create(user=c, kind="birthday", in_app=False)
    # telegram=False при in_app=True — тоже не влияет на in-app.
    NotificationPreference.objects.create(user=a, kind="sale_created", in_app=True, telegram=False)

    n = notification_broadcast(
        kind=NotificationKind.SALE_CREATED, title="t", recipient_ids=[a.id, b.id, c.id]
    )
    assert n == 2
    assert set(Notification.objects.values_list("recipient_id", flat=True)) == {a.id, c.id}


@pytest.mark.django_db
def test_broadcast_all_muted_returns_zero():
    a = _mk_user("np_a2", Role.MANAGER)
    NotificationPreference.objects.create(user=a, kind="sale_created", in_app=False)
    assert notification_broadcast(kind="sale_created", title="t", recipient_ids=[a.id]) == 0
    assert not Notification.objects.exists()


@pytest.mark.django_db
def test_broadcast_never_filters_snapshot_request():
    op = Operator.objects.create(full_name="Snap", status="active")
    u = _mk_user("np_snap", Role.OPERATOR, operator=op)
    # Даже если строка каким-то образом есть — служебный kind не режем.
    NotificationPreference.objects.create(user=u, kind="snapshot_request", in_app=False)
    assert notification_broadcast(kind="snapshot_request", title="t", recipient_ids=[u.id]) == 1


# ---------------------------------------------------------------------------
# Item 3: super_manager receives sale_created + birthday
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_super_manager_receives_sale_created_and_mute_respected():
    from apps.sales.services import sale_create

    sm = _mk_user("np_sm_sale", Role.SUPER_MANAGER)
    mgr = _mk_user("np_mgr_sale", Role.MANAGER)
    muted = _mk_user("np_mgr_muted", Role.MANAGER)
    NotificationPreference.objects.create(user=muted, kind="sale_created", in_app=False)
    op = Operator.objects.create(full_name="Seller", status="active")
    channel = Channel.objects.create(name="Telegram")

    sale_create(
        imei="490154203237518",
        phone_model="iPhone 15",
        operator_id=op.id,
        channel_id=channel.id,
        amount=Decimal("12000000"),
    )
    recipients = set(
        Notification.objects.filter(kind=NotificationKind.SALE_CREATED).values_list(
            "recipient_id", flat=True
        )
    )
    assert sm.id in recipients
    assert mgr.id in recipients
    assert muted.id not in recipients


@pytest.mark.django_db
def test_super_manager_receives_birthday_and_mute_respected():
    sm = _mk_user("np_sm_bd", Role.SUPER_MANAGER)
    muted = _mk_user("np_mgr_bd_muted", Role.MANAGER)
    NotificationPreference.objects.create(user=muted, kind="birthday", in_app=False)
    Operator.objects.create(full_name="BD", status="active", birth_date=dt.date(1995, 6, 15))

    with patch(
        "apps.operators.management.commands.birthday_notify._send_dm", return_value=True
    ):
        call_command("birthday_notify", date="2030-06-15", stdout=StringIO())

    recipients = set(
        Notification.objects.filter(kind=NotificationKind.BIRTHDAY).values_list(
            "recipient_id", flat=True
        )
    )
    assert sm.id in recipients
    assert muted.id not in recipients

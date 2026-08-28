"""
Service-layer tests for phone→operator/profile auto-linking.

Covers:
  - Bare `subscription_link_by_phone()` — normalises the raw phone,
    resolves `Operator.phone` and `Profile.user.username`.
  - Idempotency — running the linker twice with the same phone is a
    no-op (no double audit entries).
  - `subscription_update()` — manager path re-runs the resolver when
    phone changes, and audits changes with a before/after diff.
"""

from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model

from apps.audit.models import AuditLog
from apps.operators.models import Operator
from apps.tg_bot.models import BotSubscription
from apps.tg_bot.services import subscription_link_by_phone, subscription_update
from apps.users.models import Profile, Role

User = get_user_model()


@pytest.mark.django_db
def test_link_resolves_operator_by_phone():
    op = Operator.objects.create(full_name="Bonu", status="active", phone="+998901112233")
    sub = BotSubscription.objects.create(chat_id=5001, is_active=True)

    subscription_link_by_phone(subscription=sub, raw_phone="+998 90 111 22 33")
    sub.refresh_from_db()

    assert sub.phone == "+998901112233"
    assert sub.linked_operator_id == op.id


@pytest.mark.django_db
def test_link_resolves_profile_by_username():
    user = User.objects.create_user(username="+998907776655", password="testpass")
    profile, _ = Profile.objects.get_or_create(user=user)
    profile.role = Role.OPERATOR
    profile.save()

    sub = BotSubscription.objects.create(chat_id=5002, is_active=True)
    subscription_link_by_phone(subscription=sub, raw_phone="998907776655")
    sub.refresh_from_db()

    assert sub.phone == "+998907776655"
    assert sub.linked_profile_id == profile.id


@pytest.mark.django_db
def test_link_with_no_match_stores_phone_only():
    sub = BotSubscription.objects.create(chat_id=5003, is_active=True)
    subscription_link_by_phone(subscription=sub, raw_phone="+998908880000")
    sub.refresh_from_db()

    assert sub.phone == "+998908880000"
    assert sub.linked_operator_id is None
    assert sub.linked_profile_id is None


@pytest.mark.django_db
def test_link_invalid_phone_is_noop():
    sub = BotSubscription.objects.create(chat_id=5004, is_active=True)
    subscription_link_by_phone(subscription=sub, raw_phone="abc")
    sub.refresh_from_db()

    assert sub.phone == ""
    assert sub.linked_operator_id is None


@pytest.mark.django_db
def test_link_is_idempotent_no_double_audit():
    Operator.objects.create(full_name="Bonu", status="active", phone="+998901112233")
    sub = BotSubscription.objects.create(chat_id=5005, is_active=True)

    subscription_link_by_phone(subscription=sub, raw_phone="+998901112233")
    n1 = AuditLog.objects.filter(entity="tg_bot.BotSubscription").count()

    # Second identical run must not produce a second audit entry.
    subscription_link_by_phone(subscription=sub, raw_phone="+998901112233")
    n2 = AuditLog.objects.filter(entity="tg_bot.BotSubscription").count()

    assert n1 == n2 == 1


@pytest.mark.django_db
def test_subscription_update_toggle_writes_audit():
    sub = BotSubscription.objects.create(
        chat_id=5006, is_active=True, receives_broadcasts=False
    )
    user = User.objects.create_user(username="mgr", password="testpass")
    subscription_update(subscription=sub, actor=user, receives_broadcasts=True)
    sub.refresh_from_db()

    assert sub.receives_broadcasts is True
    log = AuditLog.objects.filter(entity="tg_bot.BotSubscription").first()
    assert log is not None
    assert log.user_id == user.id
    assert log.changes["after"]["receives_broadcasts"] is True


@pytest.mark.django_db
def test_subscription_update_phone_change_relinks():
    op1 = Operator.objects.create(full_name="A", status="active", phone="+998900000001")
    op2 = Operator.objects.create(full_name="B", status="active", phone="+998900000002")
    sub = BotSubscription.objects.create(
        chat_id=5007, is_active=True, phone="+998900000001", linked_operator=op1
    )
    user = User.objects.create_user(username="mgr2", password="testpass")

    subscription_update(subscription=sub, actor=user, phone="+998900000002")
    sub.refresh_from_db()

    assert sub.phone == "+998900000002"
    assert sub.linked_operator_id == op2.id


@pytest.mark.django_db
def test_subscription_update_no_change_no_audit():
    sub = BotSubscription.objects.create(
        chat_id=5008, is_active=True, receives_broadcasts=True
    )
    user = User.objects.create_user(username="mgr3", password="testpass")
    subscription_update(subscription=sub, actor=user, receives_broadcasts=True)
    assert not AuditLog.objects.filter(entity="tg_bot.BotSubscription").exists()

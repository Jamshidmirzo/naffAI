"""
Sale-celebration broadcast: when an operator (or manager) records a sale,
every *other* active operator gets a Notification(kind=sale_celebration)
so their UI can pop the confetti overlay. Sellers themselves must NOT
receive one — no self-cheering.
"""

from decimal import Decimal

import pytest
from django.contrib.auth import get_user_model

from apps.catalog.models import Channel
from apps.notifications.models import Notification, NotificationKind
from apps.operators.models import Operator
from apps.sales.services import sale_create
from apps.users.models import Profile, Role

User = get_user_model()


def _make_operator_user(username: str, full_name: str) -> tuple[Operator, User]:
    op = Operator.objects.create(full_name=full_name, status="active")
    user = User.objects.create_user(username=username, password="x")
    Profile.objects.create(user=user, role=Role.OPERATOR, operator=op)
    return op, user


@pytest.fixture
def channel(db):
    return Channel.objects.create(name="Telegram")


@pytest.mark.django_db
def test_sale_celebration_excludes_seller_notifies_peers(channel):
    op_a, user_a = _make_operator_user("op_a", "Alisher")
    op_b, user_b = _make_operator_user("op_b", "Bekzod")
    op_c, user_c = _make_operator_user("op_c", "Sardor")

    sale = sale_create(
        imei="490154203237518",
        phone_model="iPhone 15 Pro",
        operator_id=op_a.id,
        channel_id=channel.id,
        amount=Decimal("12000000"),
    )

    celebration_qs = Notification.objects.filter(
        kind=NotificationKind.SALE_CELEBRATION
    )
    recipients = set(celebration_qs.values_list("recipient_id", flat=True))

    assert user_a.id not in recipients, "seller must not receive their own celebration"
    assert user_b.id in recipients
    assert user_c.id in recipients

    note = celebration_qs.filter(recipient_id=user_b.id).get()
    assert note.metadata["sale_id"] == sale.id
    assert note.metadata["seller_id"] == op_a.id
    assert note.metadata["seller_name"] == "Alisher"
    assert note.metadata["device"] == "iPhone 15 Pro"
    assert note.metadata["amount"] == 12000000


@pytest.mark.django_db
def test_sale_celebration_skips_inactive_operators(channel):
    op_a, user_a = _make_operator_user("op_a2", "Alisher")
    op_b, user_b = _make_operator_user("op_b2", "Bekzod")
    user_b.is_active = False
    user_b.save(update_fields=["is_active"])

    sale_create(
        imei="490154203237518",
        phone_model="iPhone 15 Pro",
        operator_id=op_a.id,
        channel_id=channel.id,
        amount=Decimal("5000000"),
    )

    recipients = set(
        Notification.objects.filter(
            kind=NotificationKind.SALE_CELEBRATION
        ).values_list("recipient_id", flat=True)
    )
    assert recipients == set(), "no other active operators → nobody notified"


@pytest.mark.django_db
def test_sale_celebration_not_sent_to_managers(channel):
    op_a, user_a = _make_operator_user("op_a3", "Alisher")
    mgr = User.objects.create_user(username="mgr1", password="x")
    Profile.objects.create(user=mgr, role=Role.MANAGER)

    sale_create(
        imei="490154203237518",
        phone_model="iPhone 15 Pro",
        operator_id=op_a.id,
        channel_id=channel.id,
        amount=Decimal("5000000"),
    )

    recipients = set(
        Notification.objects.filter(
            kind=NotificationKind.SALE_CELEBRATION
        ).values_list("recipient_id", flat=True)
    )
    assert mgr.id not in recipients
    assert user_a.id not in recipients

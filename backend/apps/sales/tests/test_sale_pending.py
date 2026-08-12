"""
Pending workflow: operator submits a sale for review with a required
contract photo; manager approves / rejects / edits+approves.

Tests exercise the service layer directly + a couple of API-level cases
via APIClient to make sure the operator role gate works end-to-end.
"""

from decimal import Decimal

import pytest
from django.contrib.auth import get_user_model
from django.core.files.uploadedfile import SimpleUploadedFile
from django.utils import timezone
from rest_framework.test import APIClient

from apps.catalog.models import Channel
from apps.common.exceptions import ApplicationError
from apps.notifications.models import Notification, NotificationKind
from apps.operators.models import Operator
from apps.sales.models import Sale, SaleStatus
from apps.sales.services import sale_confirm, sale_create, sale_reject

User = get_user_model()


TINY_PNG = (
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
    b"\x08\x02\x00\x00\x00\x90wS\xde\x00\x00\x00\x0cIDATx\x9cc\xf8\xff\xff"
    b"?\x00\x05\xfe\x02\xfe\xdc\xccY\xe7\x00\x00\x00\x00IEND\xaeB`\x82"
)


@pytest.fixture
def operator(db):
    return Operator.objects.create(full_name="Мадина Иванова", status="active")


@pytest.fixture
def channel(db):
    return Channel.objects.create(name="Наличные")


@pytest.fixture
def operator_user(db, operator):
    user = User.objects.create_user(username="madina", password="testpass")
    # Profile is auto-created via signals in most apps; if not, create manually.
    from apps.users.models import Profile

    profile, _ = Profile.objects.get_or_create(user=user)
    profile.role = "operator"
    profile.operator = operator
    profile.save()
    return user


@pytest.fixture
def manager_user(db):
    user = User.objects.create_user(username="mgr", password="testpass")
    from apps.users.models import Profile

    profile, _ = Profile.objects.get_or_create(user=user)
    profile.role = "team_lead"
    profile.save()
    return user


@pytest.fixture
def photo():
    return SimpleUploadedFile(
        "contract.png", TINY_PNG, content_type="image/png"
    )


@pytest.mark.django_db
def test_operator_pending_without_photo_service_layer(operator, channel):
    with pytest.raises(ApplicationError) as exc:
        sale_create(
            imei="490154203237518",
            phone_model="iPhone 13",
            operator_id=operator.id,
            channel_id=channel.id,
            amount=Decimal("5000000"),
            status=SaleStatus.PENDING,
        )
    assert "фото договора" in exc.value.message.lower()


@pytest.mark.django_db
def test_operator_pending_with_photo_service_layer(operator, channel, photo):
    sale = sale_create(
        imei="490154203237518",
        phone_model="iPhone 13",
        operator_id=operator.id,
        channel_id=channel.id,
        amount=Decimal("5000000"),
        status=SaleStatus.PENDING,
        contract_photo=photo,
    )
    assert sale.status == SaleStatus.PENDING
    assert sale.contract_photo  # stored file
    assert sale.contract_photo.name.startswith("sales/contracts/")


@pytest.mark.django_db
def test_sale_confirm_clears_rejection_payload(operator, channel):
    """
    If a manager rejected a sale, then reconsidered and approved via the
    Improve flow, the rejection payload should not linger.
    """
    sale = sale_create(
        imei="490154203237518",
        phone_model="iPhone 13",
        operator_id=operator.id,
        channel_id=channel.id,
        amount=Decimal("5000000"),
        status=SaleStatus.PENDING,
        contract_photo=SimpleUploadedFile("c.png", TINY_PNG, content_type="image/png"),
    )
    sale.status = SaleStatus.REJECTED
    sale.rejection_reason = "wrong imei"
    sale.rejected_at = timezone.now()
    sale.save()

    sale_confirm(sale=sale, user=None)
    sale.refresh_from_db()
    assert sale.status == SaleStatus.CONFIRMED
    assert sale.rejection_reason == ""
    assert sale.rejected_at is None


@pytest.mark.django_db
def test_sale_reject_requires_reason(operator, channel):
    sale = sale_create(
        imei="490154203237518",
        phone_model="iPhone 13",
        operator_id=operator.id,
        channel_id=channel.id,
        amount=Decimal("5000000"),
        status=SaleStatus.PENDING,
        contract_photo=SimpleUploadedFile("c.png", TINY_PNG, content_type="image/png"),
    )
    with pytest.raises(ApplicationError):
        sale_reject(sale=sale, user=None, reason="   ")


@pytest.mark.django_db
def test_sale_reject_only_pending(operator, channel):
    sale = sale_create(
        imei="490154203237518",
        phone_model="iPhone 13",
        operator_id=operator.id,
        channel_id=channel.id,
        amount=Decimal("5000000"),
        # confirmed by default
    )
    with pytest.raises(ApplicationError):
        sale_reject(sale=sale, user=None, reason="too late")


@pytest.mark.django_db
def test_sale_reject_happy_path_creates_notification(
    operator, channel, operator_user
):
    sale = sale_create(
        user=operator_user,
        imei="490154203237518",
        phone_model="iPhone 13",
        operator_id=operator.id,
        channel_id=channel.id,
        amount=Decimal("5000000"),
        status=SaleStatus.PENDING,
        contract_photo=SimpleUploadedFile("c.png", TINY_PNG, content_type="image/png"),
    )
    sale_reject(sale=sale, user=None, reason="IMEI не совпадает")
    sale.refresh_from_db()
    assert sale.status == SaleStatus.REJECTED
    assert sale.rejection_reason == "IMEI не совпадает"
    assert sale.rejected_at is not None
    n = Notification.objects.filter(
        recipient=operator_user, kind=NotificationKind.SALE_REJECTED
    ).first()
    assert n is not None
    assert "IMEI не совпадает" in n.body


@pytest.mark.django_db
def test_operator_api_force_pending_and_photo_required(
    operator, channel, operator_user
):
    """Operator POSTs without photo → 400. With photo → 201 status=pending."""
    client = APIClient()
    client.force_authenticate(user=operator_user)

    # No photo → server should return 400 from service layer guard.
    resp = client.post(
        "/api/sales/",
        {
            "imei": "490154203237518",
            "phone_model": "iPhone 13",
            "channel_id": channel.id,
            "amount": "5000000",
        },
        format="multipart",
    )
    assert resp.status_code == 400

    # With photo → 201, status=pending regardless of what client tried to send.
    photo = SimpleUploadedFile("c.png", TINY_PNG, content_type="image/png")
    resp = client.post(
        "/api/sales/",
        {
            "imei": "490154203237518",
            "phone_model": "iPhone 13",
            "channel_id": channel.id,
            "amount": "5000000",
            "contract_photo": photo,
            "status": "confirmed",  # ← operator tries to force confirmed
        },
        format="multipart",
    )
    assert resp.status_code == 201, resp.data
    assert resp.data["status"] == "pending"


@pytest.mark.django_db
def test_manager_pending_list_returns_only_pending(
    operator, channel, manager_user
):
    # Confirmed sale — should not appear.
    sale_create(
        imei="490154203237511",
        phone_model="iPhone 15",
        operator_id=operator.id,
        channel_id=channel.id,
        amount=Decimal("6000000"),
    )
    # Pending — should appear.
    pending = sale_create(
        imei="490154203237512",
        phone_model="iPhone 13",
        operator_id=operator.id,
        channel_id=channel.id,
        amount=Decimal("5000000"),
        status=SaleStatus.PENDING,
        contract_photo=SimpleUploadedFile("c.png", TINY_PNG, content_type="image/png"),
    )

    client = APIClient()
    client.force_authenticate(user=manager_user)
    resp = client.get("/api/sales/pending/")
    assert resp.status_code == 200
    ids = [r["id"] for r in resp.data["results"]]
    assert pending.id in ids
    assert len(ids) == 1

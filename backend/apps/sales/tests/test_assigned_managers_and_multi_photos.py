"""
Tests for the operator-selected partner-managers (up to 2) + multi-photo
(up to 5) additions on `sale_create` / `sale_full_update`.

The service is the single write path for both, so all validation lives
there — these tests hit `sale_create` directly and only occasionally
verify the API-shaped serializer round-trip.
"""

from decimal import Decimal

import pytest
from django.contrib.auth import get_user_model
from django.core.files.uploadedfile import SimpleUploadedFile

from apps.catalog.models import Channel
from apps.common.exceptions import ApplicationError
from apps.operators.models import Operator
from apps.sales.models import (
    SaleAssignedManager,
    SaleContractPhoto,
    SaleStatus,
)
from apps.sales.services import sale_create, sale_full_update
from apps.users.models import Profile, Role

User = get_user_model()

# Same 60-byte PNG used across the sales test suite. Small enough to keep
# the in-memory uploads cheap; still a valid image so ImageField accepts it.
TINY_PNG = (
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
    b"\x08\x02\x00\x00\x00\x90wS\xde\x00\x00\x00\x0cIDATx\x9cc\xf8\xff\xff"
    b"?\x00\x05\xfe\x02\xfe\xdc\xccY\xe7\x00\x00\x00\x00IEND\xaeB`\x82"
)


def _png(name: str = "c.png") -> SimpleUploadedFile:
    return SimpleUploadedFile(name, TINY_PNG, content_type="image/png")


# --- fixtures -----------------------------------------------------------


@pytest.fixture
def operator(db):
    return Operator.objects.create(full_name="Оператор Один", status="active")


@pytest.fixture
def channel(db):
    return Channel.objects.create(name="Наличные")


def _make_manager(username: str, role: str = Role.MANAGER) -> User:
    user = User.objects.create_user(username=username, password="p")
    profile, _ = Profile.objects.get_or_create(user=user)
    profile.role = role
    profile.save()
    return user


@pytest.fixture
def two_managers(db) -> list[User]:
    return [_make_manager("m1"), _make_manager("m2")]


@pytest.fixture
def operator_role_user(db) -> User:
    return _make_manager("some_operator", role=Role.OPERATOR)


# --- happy paths --------------------------------------------------------


@pytest.mark.django_db
def test_sale_create_with_two_managers_and_three_photos_success(
    operator, channel, two_managers
):
    sale = sale_create(
        imei="490154203237518",
        phone_model="iPhone 13",
        operator_id=operator.id,
        channel_id=channel.id,
        amount=Decimal("5000000"),
        status=SaleStatus.PENDING,
        manager_partner_ids=[two_managers[0].id, two_managers[1].id],
        contract_photos=[_png("a.png"), _png("b.png"), _png("c.png")],
    )
    assert sale.id
    linked_manager_ids = set(
        SaleAssignedManager.objects.filter(sale=sale).values_list(
            "manager_id", flat=True
        )
    )
    assert linked_manager_ids == {two_managers[0].id, two_managers[1].id}
    photos = list(
        SaleContractPhoto.objects.filter(sale=sale).order_by("position")
    )
    assert len(photos) == 3
    assert [p.position for p in photos] == [0, 1, 2]
    for p in photos:
        assert p.photo.name.startswith("sales/contracts/")


@pytest.mark.django_db
def test_sale_create_falls_back_to_single_contract_photo_when_list_missing(
    operator, channel
):
    """Legacy path: only single `contract_photo` — it becomes photo #0."""
    sale = sale_create(
        imei="490154203237518",
        phone_model="iPhone 13",
        operator_id=operator.id,
        channel_id=channel.id,
        amount=Decimal("5000000"),
        status=SaleStatus.PENDING,
        contract_photo=_png("legacy.png"),
    )
    photos = list(SaleContractPhoto.objects.filter(sale=sale))
    assert len(photos) == 1
    assert photos[0].position == 0
    # Legacy field is preserved verbatim as a safety net for the old
    # prod frontend which still reads `sale.contract_photo` directly.
    assert sale.contract_photo


@pytest.mark.django_db
def test_sale_create_prefers_list_over_single_photo_when_both_present(
    operator, channel
):
    sale = sale_create(
        imei="490154203237518",
        phone_model="iPhone 13",
        operator_id=operator.id,
        channel_id=channel.id,
        amount=Decimal("5000000"),
        status=SaleStatus.PENDING,
        contract_photo=_png("legacy.png"),
        contract_photos=[_png("multi1.png"), _png("multi2.png")],
    )
    photos = list(SaleContractPhoto.objects.filter(sale=sale).order_by("position"))
    # List wins: legacy single is NOT mirrored into the gallery.
    assert len(photos) == 2
    assert all(p.position < 2 for p in photos)


# --- validation failures ------------------------------------------------


@pytest.mark.django_db
def test_sale_create_rejects_three_managers(operator, channel, two_managers):
    third = _make_manager("m3")
    with pytest.raises(ApplicationError) as exc:
        sale_create(
            imei="490154203237518",
            phone_model="iPhone 13",
            operator_id=operator.id,
            channel_id=channel.id,
            amount=Decimal("5000000"),
            status=SaleStatus.PENDING,
            manager_partner_ids=[two_managers[0].id, two_managers[1].id, third.id],
            contract_photos=[_png()],
        )
    assert "менеджеров" in exc.value.message.lower()


@pytest.mark.django_db
def test_sale_create_rejects_six_photos(operator, channel):
    with pytest.raises(ApplicationError) as exc:
        sale_create(
            imei="490154203237518",
            phone_model="iPhone 13",
            operator_id=operator.id,
            channel_id=channel.id,
            amount=Decimal("5000000"),
            status=SaleStatus.PENDING,
            contract_photos=[_png(f"p{i}.png") for i in range(6)],
        )
    assert "5" in exc.value.message or "фото" in exc.value.message.lower()


@pytest.mark.django_db
def test_sale_create_rejects_non_manager_partner_id(
    operator, channel, operator_role_user
):
    """Operator-role users are NOT valid manager-partners; API must reject."""
    with pytest.raises(ApplicationError) as exc:
        sale_create(
            imei="490154203237518",
            phone_model="iPhone 13",
            operator_id=operator.id,
            channel_id=channel.id,
            amount=Decimal("5000000"),
            status=SaleStatus.PENDING,
            manager_partner_ids=[operator_role_user.id],
            contract_photos=[_png()],
        )
    assert "недоступн" in exc.value.message.lower()


# --- update flow --------------------------------------------------------


@pytest.mark.django_db
def test_sale_full_update_replaces_managers_and_photos(
    operator, channel, two_managers
):
    """
    Improve-flow: manager PUTs the sale with a new set of partners and
    a new photo set — old links are wiped, new ones are written.
    """
    sale = sale_create(
        imei="490154203237518",
        phone_model="iPhone 13",
        operator_id=operator.id,
        channel_id=channel.id,
        amount=Decimal("5000000"),
        status=SaleStatus.PENDING,
        manager_partner_ids=[two_managers[0].id],
        contract_photos=[_png("orig1.png"), _png("orig2.png")],
    )
    # Sanity-check the pre-state.
    assert SaleAssignedManager.objects.filter(sale=sale).count() == 1
    assert SaleContractPhoto.objects.filter(sale=sale).count() == 2

    updated = sale_full_update(
        sale=sale,
        imei=sale.imei,
        phone_model=sale.phone_model,
        operator_id=operator.id,
        channel_id=channel.id,
        amount=Decimal("6000000"),
        manager_partner_ids=[two_managers[1].id],
        contract_photos=[_png("new1.png")],
    )
    assert list(
        SaleAssignedManager.objects.filter(sale=updated).values_list(
            "manager_id", flat=True
        )
    ) == [two_managers[1].id]
    photos = list(SaleContractPhoto.objects.filter(sale=updated))
    assert len(photos) == 1
    assert photos[0].photo.name.endswith("new1.png") or "new1" in photos[0].photo.name

"""
Tests for the multi-photo contract gallery (up to 5) and the multi-channel
payment split (up to 2 payment partners) on `sale_create` / `sale_full_update`.

Both features live in the sales service layer — that's where all validation
happens, so these tests hit the service directly.
"""

from decimal import Decimal

import pytest
from django.core.files.uploadedfile import SimpleUploadedFile

from apps.catalog.models import Channel
from apps.common.exceptions import ApplicationError
from apps.operators.models import Operator
from apps.sales.models import (
    SaleContractPhoto,
    SalePartner,
    SaleStatus,
)
from apps.sales.services import sale_create, sale_full_update

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
def channel_anor(db):
    return Channel.objects.create(name="Anor Bank")


@pytest.fixture
def channel_tbc(db):
    return Channel.objects.create(name="TBC")


@pytest.fixture
def channel_alif(db):
    return Channel.objects.create(name="Alif")


# --- multi-photo: happy paths ------------------------------------------


@pytest.mark.django_db
def test_sale_create_with_three_photos_success(operator, channel_anor):
    sale = sale_create(
        imei="490154203237518",
        phone_model="iPhone 13",
        operator_id=operator.id,
        channel_id=channel_anor.id,
        amount=Decimal("5000000"),
        status=SaleStatus.PENDING,
        contract_photos=[_png("a.png"), _png("b.png"), _png("c.png")],
    )
    photos = list(
        SaleContractPhoto.objects.filter(sale=sale).order_by("position")
    )
    assert len(photos) == 3
    assert [p.position for p in photos] == [0, 1, 2]
    for p in photos:
        assert p.photo.name.startswith("sales/contracts/")


@pytest.mark.django_db
def test_sale_create_falls_back_to_single_contract_photo_when_list_missing(
    operator, channel_anor
):
    """Legacy path: only single `contract_photo` — it becomes photo #0."""
    sale = sale_create(
        imei="490154203237518",
        phone_model="iPhone 13",
        operator_id=operator.id,
        channel_id=channel_anor.id,
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
    operator, channel_anor
):
    sale = sale_create(
        imei="490154203237518",
        phone_model="iPhone 13",
        operator_id=operator.id,
        channel_id=channel_anor.id,
        amount=Decimal("5000000"),
        status=SaleStatus.PENDING,
        contract_photo=_png("legacy.png"),
        contract_photos=[_png("multi1.png"), _png("multi2.png")],
    )
    photos = list(SaleContractPhoto.objects.filter(sale=sale).order_by("position"))
    # List wins: legacy single is NOT mirrored into the gallery.
    assert len(photos) == 2
    assert all(p.position < 2 for p in photos)


# --- multi-photo: validation failures ----------------------------------


@pytest.mark.django_db
def test_sale_create_rejects_six_photos(operator, channel_anor):
    with pytest.raises(ApplicationError) as exc:
        sale_create(
            imei="490154203237518",
            phone_model="iPhone 13",
            operator_id=operator.id,
            channel_id=channel_anor.id,
            amount=Decimal("5000000"),
            status=SaleStatus.PENDING,
            contract_photos=[_png(f"p{i}.png") for i in range(6)],
        )
    assert "5" in exc.value.message or "фото" in exc.value.message.lower()


# --- multi-channel: happy paths ----------------------------------------


@pytest.mark.django_db
def test_sale_create_with_two_channels_split(
    operator, channel_anor, channel_tbc
):
    """
    Business case: 10M sale = 6M Anor + 4M TBC. Backend must write two
    SalePartner rows with the right amounts, primary channel = first
    entry, Sale.amount = total.
    """
    sale = sale_create(
        imei="490154203237518",
        phone_model="iPhone 13",
        operator_id=operator.id,
        amount=Decimal("10000000"),
        status=SaleStatus.CONFIRMED,
        partners=[
            {"channel_id": channel_anor.id, "amount": "6000000"},
            {"channel_id": channel_tbc.id, "amount": "4000000"},
        ],
    )
    assert sale.amount == Decimal("10000000")
    # Primary channel FK == first split entry (Anor).
    assert sale.channel_id == channel_anor.id
    lines = list(SalePartner.objects.filter(sale=sale).order_by("id"))
    assert len(lines) == 2
    assert lines[0].partner_id == channel_anor.id
    assert lines[0].amount == Decimal("6000000")
    assert lines[1].partner_id == channel_tbc.id
    assert lines[1].amount == Decimal("4000000")


@pytest.mark.django_db
def test_sale_create_single_channel_via_legacy_channel_id(
    operator, channel_anor
):
    """Old prod frontend sends only `channel_id + amount` — path stays alive."""
    sale = sale_create(
        imei="490154203237518",
        phone_model="iPhone 13",
        operator_id=operator.id,
        channel_id=channel_anor.id,
        amount=Decimal("5000000"),
        status=SaleStatus.CONFIRMED,
    )
    lines = list(SalePartner.objects.filter(sale=sale))
    assert len(lines) == 1
    assert lines[0].partner_id == channel_anor.id
    assert lines[0].amount == Decimal("5000000")


# --- multi-channel: validation failures --------------------------------


@pytest.mark.django_db
def test_sale_create_rejects_three_channels(
    operator, channel_anor, channel_tbc, channel_alif
):
    with pytest.raises(ApplicationError) as exc:
        sale_create(
            imei="490154203237518",
            phone_model="iPhone 13",
            operator_id=operator.id,
            amount=Decimal("9000000"),
            status=SaleStatus.CONFIRMED,
            partners=[
                {"channel_id": channel_anor.id, "amount": "3000000"},
                {"channel_id": channel_tbc.id, "amount": "3000000"},
                {"channel_id": channel_alif.id, "amount": "3000000"},
            ],
        )
    # Message mentions the limit.
    assert "2" in exc.value.message or "канал" in exc.value.message.lower()


@pytest.mark.django_db
def test_sale_create_rejects_duplicate_channel_in_split(
    operator, channel_anor
):
    with pytest.raises(ApplicationError) as exc:
        sale_create(
            imei="490154203237518",
            phone_model="iPhone 13",
            operator_id=operator.id,
            amount=Decimal("5000000"),
            status=SaleStatus.CONFIRMED,
            partners=[
                {"channel_id": channel_anor.id, "amount": "3000000"},
                {"channel_id": channel_anor.id, "amount": "2000000"},
            ],
        )
    assert "дважды" in exc.value.message.lower() or "уник" in exc.value.message.lower()


@pytest.mark.django_db
def test_sale_create_rejects_mismatched_total_vs_split_sum(
    operator, channel_anor, channel_tbc
):
    """10M total but partners sum to 9M → hard error, no silent rounding."""
    with pytest.raises(ApplicationError) as exc:
        sale_create(
            imei="490154203237518",
            phone_model="iPhone 13",
            operator_id=operator.id,
            amount=Decimal("10000000"),
            status=SaleStatus.CONFIRMED,
            partners=[
                {"channel_id": channel_anor.id, "amount": "6000000"},
                {"channel_id": channel_tbc.id, "amount": "3000000"},
            ],
        )
    assert exc.value.extra.get("field") == "partners"


# --- update flow: multi-channel + photos --------------------------------


@pytest.mark.django_db
def test_sale_full_update_replaces_photos_and_channels(
    operator, channel_anor, channel_tbc
):
    sale = sale_create(
        imei="490154203237518",
        phone_model="iPhone 13",
        operator_id=operator.id,
        channel_id=channel_anor.id,
        amount=Decimal("5000000"),
        status=SaleStatus.PENDING,
        contract_photos=[_png("orig1.png"), _png("orig2.png")],
    )
    assert SaleContractPhoto.objects.filter(sale=sale).count() == 2
    assert SalePartner.objects.filter(sale=sale).count() == 1

    updated = sale_full_update(
        sale=sale,
        imei=sale.imei,
        phone_model=sale.phone_model,
        operator_id=operator.id,
        amount=Decimal("6000000"),
        partners=[
            {"channel_id": channel_anor.id, "amount": "4000000"},
            {"channel_id": channel_tbc.id, "amount": "2000000"},
        ],
        contract_photos=[_png("new1.png")],
    )
    photos = list(SaleContractPhoto.objects.filter(sale=updated))
    assert len(photos) == 1
    lines = list(SalePartner.objects.filter(sale=updated).order_by("id"))
    assert len(lines) == 2
    assert lines[0].amount + lines[1].amount == Decimal("6000000")

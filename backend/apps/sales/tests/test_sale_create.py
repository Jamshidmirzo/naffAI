from decimal import Decimal

import pytest

from apps.catalog.models import Channel
from apps.common.exceptions import ApplicationError, DuplicateError
from apps.operators.models import Operator
from apps.sales.services import sale_create


@pytest.fixture
def operator(db):
    return Operator.objects.create(full_name="Тестовый Оператор", status="active")


@pytest.fixture
def channel(db):
    return Channel.objects.create(name="Telegram")


@pytest.mark.django_db
def test_sale_create_rejects_invalid_imei(operator, channel):
    with pytest.raises(ApplicationError):
        sale_create(
            imei="123",
            phone_model="X",
            operator_id=operator.id,
            channel_id=channel.id,
            amount=Decimal("1000000"),
        )


@pytest.mark.django_db
def test_sale_create_happy_path(operator, channel):
    sale = sale_create(
        imei="490154203237518",
        phone_model="iPhone 13",
        operator_id=operator.id,
        channel_id=channel.id,
        amount=Decimal("3500000"),
    )
    assert sale.id
    assert sale.amount == Decimal("3500000")


@pytest.mark.django_db
def test_sale_create_duplicate_imei_blocks(operator, channel):
    sale_create(
        imei="490154203237518",
        phone_model="iPhone 13",
        operator_id=operator.id,
        channel_id=channel.id,
        amount=Decimal("3500000"),
    )
    with pytest.raises(DuplicateError):
        sale_create(
            imei="490154203237518",
            phone_model="iPhone 13",
            operator_id=operator.id,
            channel_id=channel.id,
            amount=Decimal("3500000"),
        )


@pytest.mark.django_db
def test_sale_create_duplicate_override_requires_comment(operator, channel):
    sale_create(
        imei="490154203237518",
        phone_model="iPhone 13",
        operator_id=operator.id,
        channel_id=channel.id,
        amount=Decimal("3500000"),
    )
    with pytest.raises(ApplicationError):
        sale_create(
            imei="490154203237518",
            phone_model="iPhone 13",
            operator_id=operator.id,
            channel_id=channel.id,
            amount=Decimal("3500000"),
            allow_duplicate_imei=True,
            duplicate_override_comment="",
        )
    # With a comment, it goes through
    s = sale_create(
        imei="490154203237518",
        phone_model="iPhone 13",
        operator_id=operator.id,
        channel_id=channel.id,
        amount=Decimal("3500000"),
        allow_duplicate_imei=True,
        duplicate_override_comment="Замена, оригинал утерян",
    )
    assert s.id

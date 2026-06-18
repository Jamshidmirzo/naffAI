from decimal import Decimal

import pytest
from rest_framework.exceptions import ValidationError

from apps.catalog.models import Channel
from apps.operators.models import Operator
from apps.operators.services import operator_delete
from apps.sales.services import sale_create


@pytest.fixture
def operator(db):
    return Operator.objects.create(full_name="Удаляемый Оператор", status="active")


@pytest.fixture
def channel(db):
    return Channel.objects.create(name="Telegram")


@pytest.mark.django_db
def test_operator_delete_without_sales(operator):
    operator_id = operator.id
    operator_delete(operator=operator, user=None)
    assert not Operator.objects.filter(pk=operator_id).exists()


@pytest.mark.django_db
def test_operator_delete_with_sales_is_refused(operator, channel):
    sale_create(
        imei="490154203237518",
        phone_model="iPhone 13",
        operator_id=operator.id,
        channel_id=channel.id,
        amount=Decimal("3500000"),
    )
    with pytest.raises(ValidationError) as exc:
        operator_delete(operator=operator, user=None)
    msg = str(exc.value)
    assert "Удаление невозможно" in msg
    assert "деактивацию" in msg
    # Operator must still be there.
    assert Operator.objects.filter(pk=operator.id).exists()

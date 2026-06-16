from decimal import Decimal

import pytest
from django.utils import timezone

from apps.catalog.models import Channel
from apps.operators.models import Operator
from apps.sales.services import sale_create, sale_full_update, sale_partial_update


@pytest.fixture
def operator(db):
    return Operator.objects.create(full_name="Тестовый Оператор", status="active")


@pytest.fixture
def operator2(db):
    return Operator.objects.create(full_name="Второй Оператор", status="active")


@pytest.fixture
def channel(db):
    return Channel.objects.create(name="Telegram")


@pytest.fixture
def channel2(db):
    return Channel.objects.create(name="Cash")


@pytest.fixture
def existing_sale(operator, channel):
    return sale_create(
        imei="490154203237518",
        phone_model="iPhone 13",
        operator_id=operator.id,
        channel_id=channel.id,
        amount=Decimal("3500000"),
        client_name="Иван",
        client_phone="+998901234567",
        comment="initial",
    )


@pytest.mark.django_db
def test_partial_update_only_sold_at_preserves_everything(existing_sale):
    original_imei = existing_sale.imei
    original_amount = existing_sale.amount
    original_op_lines = list(existing_sale.operator_lines.values_list("operator_id", "amount"))
    new_dt = timezone.now() - timezone.timedelta(days=3)

    sale_partial_update(sale=existing_sale, fields={"sold_at": new_dt})

    existing_sale.refresh_from_db()
    assert existing_sale.sold_at.date() == new_dt.date()
    # Nothing else changed
    assert existing_sale.imei == original_imei
    assert existing_sale.amount == original_amount
    assert existing_sale.client_name == "Иван"
    assert existing_sale.client_phone == "+998901234567"
    new_op_lines = list(existing_sale.operator_lines.values_list("operator_id", "amount"))
    assert new_op_lines == original_op_lines


@pytest.mark.django_db
def test_partial_update_drops_unsafe_fields(existing_sale):
    """imei, amount, status, operator should NOT be touchable via partial update."""
    sale_partial_update(
        sale=existing_sale,
        fields={"imei": "999999999999999", "amount": "1", "status": "pending"},
    )
    existing_sale.refresh_from_db()
    assert existing_sale.imei == "490154203237518"
    assert existing_sale.amount == Decimal("3500000")
    assert existing_sale.status == "confirmed"


@pytest.mark.django_db
def test_partial_update_empty_sold_at_does_not_clobber(existing_sale):
    original = existing_sale.sold_at
    sale_partial_update(sale=existing_sale, fields={"sold_at": None})
    existing_sale.refresh_from_db()
    assert existing_sale.sold_at == original


@pytest.mark.django_db
def test_full_update_preserves_sold_at_when_not_passed(existing_sale, operator, channel):
    original = existing_sale.sold_at
    sale_full_update(
        sale=existing_sale,
        imei=existing_sale.imei,
        phone_model="iPhone 13 Pro",
        operators=[{"operator_id": operator.id, "amount": "3500000"}],
        partners=[{"partner_id": channel.id, "amount": "3500000"}],
    )
    existing_sale.refresh_from_db()
    assert existing_sale.sold_at == original
    assert existing_sale.phone_model == "iPhone 13 Pro"


@pytest.mark.django_db
def test_full_update_rebuilds_lines(existing_sale, operator, operator2, channel, channel2):
    sale_full_update(
        sale=existing_sale,
        imei=existing_sale.imei,
        operators=[
            {"operator_id": operator.id, "amount": "2000000"},
            {"operator_id": operator2.id, "amount": "1500000"},
        ],
        partners=[
            {"partner_id": channel.id, "amount": "2000000"},
            {"partner_id": channel2.id, "amount": "1500000"},
        ],
    )
    existing_sale.refresh_from_db()
    op_rows = list(existing_sale.operator_lines.values_list("operator_id", "amount"))
    partner_rows = list(existing_sale.partner_lines.values_list("partner_id", "amount"))
    assert {r[0] for r in op_rows} == {operator.id, operator2.id}
    assert {r[0] for r in partner_rows} == {channel.id, channel2.id}
    assert existing_sale.amount == Decimal("3500000")

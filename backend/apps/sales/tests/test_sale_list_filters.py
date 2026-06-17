"""
Multi-select operator / partner filters on the Sales list selector.

Covers the case the manager hits from the Sales page filter panel:
"show me sales credited to Alif OR Birzum partners, and where either
Operator A or B was a seller". Both filters use `__in` across the
legacy primary FK and the line-allocation tables, with `distinct` so
a sale split across multiple matching operators does not duplicate.
"""

from __future__ import annotations

from datetime import timedelta
from decimal import Decimal

import pytest
from django.utils import timezone

from apps.catalog.models import Channel
from apps.operators.models import Operator
from apps.sales.models import Sale, SaleOperator, SalePartner
from apps.sales.selectors import sale_list


@pytest.fixture
def op_a(db):
    return Operator.objects.create(full_name="Оператор A", status="active")


@pytest.fixture
def op_b(db):
    return Operator.objects.create(full_name="Оператор B", status="active")


@pytest.fixture
def op_c(db):
    return Operator.objects.create(full_name="Оператор C", status="active")


@pytest.fixture
def chan_alif(db):
    return Channel.objects.create(name="Alif")


@pytest.fixture
def chan_birzum(db):
    return Channel.objects.create(name="Birzum")


@pytest.fixture
def chan_hamroh(db):
    return Channel.objects.create(name="Hamroh")


def _make_sale(*, op, chan, imei, amount="1000000", op_lines=None, partner_lines=None):
    sale = Sale.objects.create(
        imei=imei,
        phone_model="Test",
        operator=op,
        channel=chan,
        amount=Decimal(amount),
        sold_at=timezone.now(),
        status="confirmed",
    )
    if op_lines:
        for o, amt in op_lines:
            SaleOperator.objects.create(sale=sale, operator=o, amount=Decimal(amt))
    if partner_lines:
        for p, amt in partner_lines:
            SalePartner.objects.create(sale=sale, partner=p, amount=Decimal(amt))
    return sale


@pytest.mark.django_db
def test_operator_ids_matches_primary_fk(op_a, op_b, op_c, chan_alif):
    s1 = _make_sale(op=op_a, chan=chan_alif, imei="490154203237518")
    s2 = _make_sale(op=op_b, chan=chan_alif, imei="356938035643809")
    _make_sale(op=op_c, chan=chan_alif, imei="013977000272858")

    res = list(sale_list(operator_ids=[op_a.id, op_b.id]))
    assert {s.id for s in res} == {s1.id, s2.id}


@pytest.mark.django_db
def test_operator_ids_matches_split_allocation(op_a, op_b, op_c, chan_alif):
    """A sale assigned primarily to C but with a line credit to A should
    be returned when filtering by [A]."""
    s1 = _make_sale(
        op=op_c,
        chan=chan_alif,
        imei="490154203237518",
        op_lines=[(op_c, "500000"), (op_a, "500000")],
    )
    s2 = _make_sale(op=op_c, chan=chan_alif, imei="356938035643809")

    res = list(sale_list(operator_ids=[op_a.id]))
    assert [s.id for s in res] == [s1.id]
    assert s2.id not in {s.id for s in res}


@pytest.mark.django_db
def test_operator_ids_does_not_duplicate_on_multiple_matches(op_a, op_b, chan_alif):
    """Sale credited to both A and B (split) should appear once when
    the filter is [A, B], not twice."""
    s = _make_sale(
        op=op_a,
        chan=chan_alif,
        imei="490154203237518",
        op_lines=[(op_a, "500000"), (op_b, "500000")],
    )
    res = list(sale_list(operator_ids=[op_a.id, op_b.id]))
    assert [x.id for x in res] == [s.id]


@pytest.mark.django_db
def test_partner_ids_matches_primary_fk(op_a, chan_alif, chan_birzum, chan_hamroh):
    s1 = _make_sale(op=op_a, chan=chan_alif, imei="490154203237518")
    s2 = _make_sale(op=op_a, chan=chan_birzum, imei="356938035643809")
    _make_sale(op=op_a, chan=chan_hamroh, imei="013977000272858")

    res = list(sale_list(partner_ids=[chan_alif.id, chan_birzum.id]))
    assert {s.id for s in res} == {s1.id, s2.id}


@pytest.mark.django_db
def test_partner_ids_matches_split_payment(op_a, chan_alif, chan_birzum, chan_hamroh):
    """Sale primarily on Hamroh but with a split Alif partner line
    should be matched when filtering by [Alif]."""
    s1 = _make_sale(
        op=op_a,
        chan=chan_hamroh,
        imei="490154203237518",
        partner_lines=[(chan_hamroh, "500000"), (chan_alif, "500000")],
    )
    _make_sale(op=op_a, chan=chan_birzum, imei="356938035643809")
    res = list(sale_list(partner_ids=[chan_alif.id]))
    assert [s.id for s in res] == [s1.id]


@pytest.mark.django_db
def test_default_ordering_is_sold_at_desc(op_a, chan_alif):
    """Selector must return newest-first so the UI can drop the column
    sort UI altogether."""
    now = timezone.now()
    older = Sale.objects.create(
        imei="490154203237518",
        phone_model="X",
        operator=op_a,
        channel=chan_alif,
        amount=Decimal("1000000"),
        sold_at=now - timedelta(days=2),
        status="confirmed",
    )
    newer = Sale.objects.create(
        imei="356938035643809",
        phone_model="X",
        operator=op_a,
        channel=chan_alif,
        amount=Decimal("1000000"),
        sold_at=now,
        status="confirmed",
    )
    ids = [s.id for s in sale_list()]
    assert ids.index(newer.id) < ids.index(older.id)

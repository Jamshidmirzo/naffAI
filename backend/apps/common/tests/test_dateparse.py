"""
Regression: bare-date query params must snap to end-of-day for
inclusive-range filters and midnight for start-range filters.

Before the fix, `parse_datetime("2026-08-31")` on Py3.12 returned a
naive midnight (fromisoformat accepts bare dates), so the branch that
would have snapped to end-of-day was dead — every sale after 00:00 on
`date_to` was silently clipped.
"""

from __future__ import annotations

import datetime as dt

import pytest
from django.utils import timezone

from apps.common.dateparse import parse_dt_end, parse_dt_start


def test_parse_dt_start_bare_date_is_midnight_aware():
    parsed = parse_dt_start("2026-08-31")
    assert parsed is not None
    assert timezone.is_aware(parsed)
    assert parsed.hour == 0
    assert parsed.minute == 0
    assert parsed.second == 0


def test_parse_dt_end_bare_date_is_end_of_day_aware():
    parsed = parse_dt_end("2026-08-31")
    assert parsed is not None
    assert timezone.is_aware(parsed)
    assert parsed.hour == 23
    assert parsed.minute == 59
    assert parsed.second == 59


def test_parse_dt_start_iso_datetime_kept_as_is():
    parsed = parse_dt_start("2026-08-31T14:30:00+05:00")
    assert parsed is not None
    assert timezone.is_aware(parsed)
    assert parsed.hour == 14
    assert parsed.minute == 30


def test_parse_dt_end_iso_datetime_kept_as_is():
    parsed = parse_dt_end("2026-08-31T09:15:00+05:00")
    assert parsed is not None
    assert parsed.hour == 9
    assert parsed.minute == 15


def test_parse_naive_iso_datetime_is_made_aware():
    parsed = parse_dt_start("2026-08-31T14:30:00")
    assert parsed is not None
    assert timezone.is_aware(parsed)


def test_parse_none_returns_none():
    assert parse_dt_start(None) is None
    assert parse_dt_end(None) is None
    assert parse_dt_start("") is None
    assert parse_dt_end("") is None


def test_parse_invalid_returns_none():
    assert parse_dt_start("not-a-date") is None
    assert parse_dt_end("2026-13-45") is None


@pytest.mark.django_db
def test_sale_list_bare_date_to_includes_last_day():
    """The whole point: `date_to=2026-08-31` must include a sale that
    happened at 18:00 on the 31st, not clip it away."""

    from decimal import Decimal

    from apps.catalog.models import Channel
    from apps.operators.models import Operator
    from apps.sales.models import Sale
    from apps.sales.selectors import sale_list

    op = Operator.objects.create(full_name="Test op", status="active")
    chan = Channel.objects.create(name="Testchan")

    tz = timezone.get_current_timezone()
    august_evening = timezone.make_aware(dt.datetime(2026, 8, 31, 18, 0, 0), tz)

    Sale.objects.create(
        imei="490154203237518",
        phone_model="X",
        operator=op,
        channel=chan,
        amount=Decimal("1000000"),
        sold_at=august_evening,
        status="confirmed",
    )

    date_from = parse_dt_start("2026-08-01")
    date_to = parse_dt_end("2026-08-31")
    ids = [s.id for s in sale_list(date_from=date_from, date_to=date_to)]
    assert len(ids) == 1, "Bare date_to must be inclusive of the last day"

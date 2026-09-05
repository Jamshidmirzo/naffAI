"""dashboard_summary(month=YYYY-MM) — конкретный календарный месяц."""

from __future__ import annotations

import pytest

from apps.analytics.selectors import _month_bounds, dashboard_summary


def test_month_bounds_mid_year():
    cur_start, cur_end, prev_start, prev_end = _month_bounds("2026-08")
    assert (cur_start.year, cur_start.month, cur_start.day) == (2026, 8, 1)
    assert (cur_end.year, cur_end.month, cur_end.day) == (2026, 9, 1)
    assert (prev_start.year, prev_start.month) == (2026, 7)
    assert prev_end == cur_start


def test_month_bounds_january_wraps_year():
    cur_start, cur_end, prev_start, prev_end = _month_bounds("2026-01")
    assert (prev_start.year, prev_start.month) == (2025, 12)
    assert (cur_end.year, cur_end.month) == (2026, 2)


def test_month_bounds_december_wraps_year():
    cur_start, cur_end, _, _ = _month_bounds("2026-12")
    assert (cur_end.year, cur_end.month) == (2027, 1)


@pytest.mark.parametrize("bad", ["", "abc", "2026-13", "2026", "2026-00"])
def test_month_bounds_invalid(bad):
    assert _month_bounds(bad) is None


@pytest.mark.django_db
def test_dashboard_summary_month_period_label():
    out = dashboard_summary(month="2026-08")
    assert out["period"] == "month:2026-08"


@pytest.mark.django_db
def test_dashboard_summary_bad_month_falls_back():
    out = dashboard_summary(period="day", month="garbage")
    assert out["period"] == "day"

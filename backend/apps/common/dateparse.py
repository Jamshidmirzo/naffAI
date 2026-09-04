"""Shared datetime parsers for query-parameter date filters.

Filters panels on the SPA send `<input type="date">` values (bare
`YYYY-MM-DD`) as well as ISO datetimes (e.g. `2026-08-31T18:00:00+05:00`).
Django's `parse_datetime` in Python 3.12 will happily parse a bare date
via `datetime.fromisoformat` — returning a *naive* midnight — which then
silently propagates through querysets as a naive-datetime warning and,
worse, clips the last day of the range when it is passed as
`sold_at__lte` (bare date "2026-08-31" → midnight → cuts every sale that
happened later that day).

`parse_dt_start` and `parse_dt_end` normalise both cases: bare dates snap
to `time.min` / `time.max` in the active timezone; datetimes stay as-is
but naive values are made timezone-aware.
"""

from __future__ import annotations

import datetime as dt

from django.utils import timezone
from django.utils.dateparse import parse_date, parse_datetime


def _as_aware(value: dt.datetime) -> dt.datetime:
    if timezone.is_naive(value):
        return timezone.make_aware(value)
    return value


def _parse(value: str | None, *, snap_end: bool) -> dt.datetime | None:
    if not value:
        return None
    # Bare date wins: `parse_datetime` in Py3.12 will parse it via
    # fromisoformat and return a naive midnight, which is not what we
    # want for filters. Detect the bare-date shape first.
    #
    # `parse_date` может кинуть ValueError на well-formed, но невалидные
    # даты (например `2026-13-45`): «month must be in 1..12». Для внешнего
    # API проще вернуть None — фильтр молча проигнорирует битый параметр.
    try:
        d = parse_date(value)
    except (ValueError, TypeError):
        d = None
    if d is not None:
        boundary = dt.time.max if snap_end else dt.time.min
        return timezone.make_aware(dt.datetime.combine(d, boundary))

    try:
        parsed = parse_datetime(value)
    except (ValueError, TypeError):
        return None
    if parsed is None:
        return None
    return _as_aware(parsed)


def parse_dt_start(value: str | None) -> dt.datetime | None:
    """Parse a start-of-range value. Bare date → 00:00 local time."""

    return _parse(value, snap_end=False)


def parse_dt_end(value: str | None) -> dt.datetime | None:
    """Parse an end-of-range value. Bare date → 23:59:59.999999 local time.

    This mirrors the way users think about `date_to=2026-08-31`: every
    sale on that day, not "everything strictly before midnight of the
    31st".
    """

    return _parse(value, snap_end=True)

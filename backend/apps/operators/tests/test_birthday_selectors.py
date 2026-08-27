"""
Selectors для «день рождения» — базовая матчинг-логика.

Ключевые проверки:
  * год ДР не влияет — оператор попадает в выборку каждый год;
  * inactive исключаются;
  * NULL birth_date не матчится;
  * 29 февраля — в невисокосный год именинники празднуют 28 фев;
  * `_age_years` корректно считает полные годы (в т.ч. edge-case 29.02).
"""

from __future__ import annotations

import datetime as dt

import pytest

from apps.operators.models import Operator
from apps.operators.selectors import (
    _age_years,
    operators_with_birthday_today,
    operators_with_birthday_today_public,
)


@pytest.fixture
def active_op(db):
    return Operator.objects.create(
        full_name="Активная Иванова",
        status="active",
        phone="+998900000001",
        birth_date=dt.date(1995, 6, 15),
    )


@pytest.fixture
def trainee_op(db):
    return Operator.objects.create(
        full_name="Стажёр Стажёрович",
        status="trainee",
        birth_date=dt.date(2003, 6, 15),
    )


@pytest.fixture
def inactive_op(db):
    return Operator.objects.create(
        full_name="Ушедший Мамедов",
        status="inactive",
        birth_date=dt.date(1990, 6, 15),
    )


@pytest.fixture
def no_bd_op(db):
    return Operator.objects.create(full_name="Безымянный", status="active", birth_date=None)


@pytest.mark.django_db
def test_year_of_birth_is_ignored(active_op):
    """Матч по day/month — год не важен."""
    today = dt.date(2030, 6, 15)  # тот же day/month, но 2030
    ids = list(operators_with_birthday_today(today=today).values_list("id", flat=True))
    assert active_op.id in ids


@pytest.mark.django_db
def test_different_day_no_match(active_op):
    today = dt.date(2030, 6, 16)
    ids = list(operators_with_birthday_today(today=today).values_list("id", flat=True))
    assert active_op.id not in ids


@pytest.mark.django_db
def test_inactive_excluded(active_op, inactive_op):
    today = dt.date(2030, 6, 15)
    ids = list(operators_with_birthday_today(today=today).values_list("id", flat=True))
    assert active_op.id in ids
    assert inactive_op.id not in ids


@pytest.mark.django_db
def test_trainee_included(trainee_op):
    today = dt.date(2030, 6, 15)
    ids = list(operators_with_birthday_today(today=today).values_list("id", flat=True))
    assert trainee_op.id in ids


@pytest.mark.django_db
def test_null_birth_date_never_matches(no_bd_op):
    today = dt.date(2030, 6, 15)
    ids = list(operators_with_birthday_today(today=today).values_list("id", flat=True))
    assert no_bd_op.id not in ids


@pytest.mark.django_db
def test_feb29_non_leap_year_matches_on_feb28(db):
    op = Operator.objects.create(
        full_name="Феврал Марта", status="active", birth_date=dt.date(2000, 2, 29)
    )
    # 2027 — не високосный, 28 февраля должен подхватить оператора.
    today = dt.date(2027, 2, 28)
    ids = list(operators_with_birthday_today(today=today).values_list("id", flat=True))
    assert op.id in ids


@pytest.mark.django_db
def test_feb29_leap_year_matches_only_on_feb29(db):
    op = Operator.objects.create(
        full_name="Феврал Марта", status="active", birth_date=dt.date(2000, 2, 29)
    )
    # В високосном году 28 фев не должен матчить (реальный ДР — 29 фев).
    today = dt.date(2028, 2, 28)
    ids = list(operators_with_birthday_today(today=today).values_list("id", flat=True))
    assert op.id not in ids
    today = dt.date(2028, 2, 29)
    ids = list(operators_with_birthday_today(today=today).values_list("id", flat=True))
    assert op.id in ids


@pytest.mark.django_db
def test_age_years_basic():
    """Полные годы, day-of-month порог."""
    assert _age_years(dt.date(1990, 6, 15), dt.date(2020, 6, 15)) == 30
    # ДР ещё не наступил — минус один
    assert _age_years(dt.date(1990, 6, 15), dt.date(2020, 6, 14)) == 29
    # После ДР — точно N лет
    assert _age_years(dt.date(1990, 6, 15), dt.date(2020, 6, 16)) == 30


@pytest.mark.django_db
def test_age_years_feb29_non_leap():
    """29-февральский именинник в невисокосный год: age = today.year - birth.year, если today >= 28 фев."""
    # 28 февраля 2027 (не високосный) — «сегодняшний ДР», age = 27
    assert _age_years(dt.date(2000, 2, 29), dt.date(2027, 2, 28)) == 27
    # 27 февраля 2027 — ещё не наступил → age = 26
    assert _age_years(dt.date(2000, 2, 29), dt.date(2027, 2, 27)) == 26


@pytest.mark.django_db
def test_age_years_future_birth_returns_zero():
    """Data-glitch защита."""
    assert _age_years(dt.date(3000, 1, 1), dt.date(2027, 1, 1)) == 0


@pytest.mark.django_db
def test_public_projection_hides_birth_year(active_op):
    today = dt.date(2030, 6, 15)
    rows = operators_with_birthday_today_public(today=today)
    assert rows, "должен быть хотя бы один именинник"
    row = next(r for r in rows if r["operator_id"] == active_op.id)
    assert set(row.keys()) == {"operator_id", "full_name", "phone", "age", "status"}
    # Год ДР (1995) наружу не отдаём.
    assert row["age"] == 35  # 2030 - 1995

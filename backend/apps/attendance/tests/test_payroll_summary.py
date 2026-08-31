"""
Тесты `attendance_payroll_summary` в 2-gate модели (2026-08-31 rewrite).

Модель:
  - `total_earned = attendance.block_earned + sales.block_earned`, где
    каждый блок — жёсткий бинарный гейт.
  - Attendance: если посещаемость ≥ гейта → бонус минус штрафы за
    опоздания (× late_penalty_uzs); иначе 0.
  - Sales: если план выполнен на ≥ sales_gate_pct → бонус; иначе 0.

Все тайминги в Asia/Tashkent.
"""

from __future__ import annotations

import calendar
import datetime as dt
from decimal import Decimal

import pytest
from django.utils import timezone

from apps.attendance.models import AttendanceLog
from apps.attendance.selectors import (
    attendance_payroll_summary,
    attendance_settings_get,
)
from apps.catalog.models import Channel
from apps.operators.models import Operator, OperatorMonthlyPlan
from apps.sales.models import Sale, SaleOperator


def _get_or_make_channel() -> Channel:
    """
    Sale.channel — FK, обязательный. Каналы шарятся между тестами кейса,
    поэтому берём первый существующий или создаём один раз. Все тесты
    module-scoped через `@pytest.mark.django_db` откатывают транзакцию.
    """
    obj = Channel.objects.first()
    if obj:
        return obj
    return Channel.objects.create(name="Test-Channel")


@pytest.fixture
def settings_obj(db):
    s = attendance_settings_get()
    s.shift_start = dt.time(10, 0)
    s.shift_end = dt.time(20, 0)
    s.default_salary_uzs = Decimal("1500000")
    s.default_grace_period_min = 20
    s.default_late_penalty_uzs = Decimal("50000")
    s.default_weekly_day_off = 6  # Вс
    s.default_attendance_gate_pct = 85
    s.default_weekly_free_absences = 1
    s.default_attendance_bonus_uzs = Decimal("1500000")
    s.default_sales_bonus_uzs = Decimal("1500000")
    s.default_sales_gate_pct = 85
    s.default_monthly_plan_uzs = Decimal("10000000")
    s.save()
    return s


@pytest.fixture
def operator(db):
    return Operator.objects.create(full_name="Тест Оплата", status="active")


def _mklog(operator: Operator, *, date: dt.date, hour: int, minute: int) -> AttendanceLog:
    tz = timezone.get_current_timezone()
    checked_in = dt.datetime(
        date.year, date.month, date.day, hour, minute, 0, tzinfo=tz
    )
    return AttendanceLog.objects.create(
        operator=operator,
        checked_in_at=checked_in,
        checked_out_at=checked_in + dt.timedelta(hours=8),
        was_late=False,
        source="manual",
    )


def _weekdays_of_month(year: int, month: int, day_off: int) -> list[dt.date]:
    _, last_day = calendar.monthrange(year, month)
    return [
        dt.date(year, month, d)
        for d in range(1, last_day + 1)
        if dt.date(year, month, d).weekday() != day_off
    ]


def _make_sales(operator: Operator, year: int, month: int, total_amount: Decimal) -> None:
    """Создаёт одну confirmed Sale + SaleOperator на весь `total_amount`."""
    tz = timezone.get_current_timezone()
    sold_at = dt.datetime(year, month, 5, 12, 0, tzinfo=tz)
    ch = _get_or_make_channel()
    sale = Sale.objects.create(
        imei="000000000000000",
        phone_model="Test",
        channel=ch,
        amount=total_amount,
        sold_at=sold_at,
        status="confirmed",
        is_returned=False,
        is_deleted=False,
    )
    SaleOperator.objects.create(sale=sale, operator=operator, amount=total_amount)


# ---------------------------------------------------------------------------
# 1. Attendance 100% + Sales 100% → полные 3M
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_both_gates_passed_earns_full_max(operator, settings_obj):
    year, month = 2026, 3
    for day in _weekdays_of_month(year, month, day_off=6):
        _mklog(operator, date=day, hour=10, minute=0)
    _make_sales(operator, year, month, Decimal("10000000"))

    summary = attendance_payroll_summary(operator, year, month)
    assert summary["attendance"]["gate_passed"] is True
    assert summary["sales"]["gate_passed"] is True
    assert summary["attendance"]["block_earned"] == "1500000"
    assert summary["sales"]["block_earned"] == "1500000"
    assert summary["total_earned"] == "3000000"
    assert summary["max_possible"] == "3000000"


# ---------------------------------------------------------------------------
# 2. Attendance passed 90%, sales только 60% → 1.5M attendance, 0 sales
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_attendance_passes_sales_fails(operator, settings_obj):
    year, month = 2026, 3
    weekdays = _weekdays_of_month(year, month, day_off=6)
    # Посетил все дни → 100% posещ.
    for day in weekdays:
        _mklog(operator, date=day, hour=10, minute=0)
    # Продажи 60% от 10M → 6M.
    _make_sales(operator, year, month, Decimal("6000000"))

    summary = attendance_payroll_summary(operator, year, month)
    assert summary["attendance"]["gate_passed"] is True
    assert summary["attendance"]["block_earned"] == "1500000"
    assert summary["sales"]["gate_passed"] is False
    assert summary["sales"]["block_earned"] == "0"
    assert summary["total_earned"] == "1500000"
    # Shortfall: (10M × 0.85) - 6M = 2.5M
    assert Decimal(summary["sales"]["shortfall"]["amount_more_needed"]) == Decimal("2500000")


# ---------------------------------------------------------------------------
# 3. Attendance 80% (провален), sales 90% → 0 attendance, 1.5M sales
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_attendance_fails_sales_passes(operator, settings_obj):
    year, month = 2026, 3
    weekdays = _weekdays_of_month(year, month, day_off=6)
    # Март 2026: 26 рабочих дней (31 всего − 5 воскресений). 80% ≈ 20.8;
    # чтобы гейт провалить (< 85%) — посетить не больше 21 дня.
    # 21/26 = 80.77% < 85%.
    for day in weekdays[:21]:
        _mklog(operator, date=day, hour=10, minute=0)
    _make_sales(operator, year, month, Decimal("9000000"))  # 90%

    summary = attendance_payroll_summary(operator, year, month)
    assert summary["attendance"]["gate_passed"] is False
    assert summary["attendance"]["block_earned"] == "0"
    assert summary["sales"]["gate_passed"] is True
    assert summary["sales"]["block_earned"] == "1500000"
    assert summary["total_earned"] == "1500000"
    # Shortfall: ceil(85% × 26) - 21 = ceil(22.1) - 21 = 23 - 21 = 2
    assert summary["attendance"]["shortfall"]["days_more_needed"] == 2


# ---------------------------------------------------------------------------
# 4. Attendance 100% с 3 опозданиями → 1.5M − 3 × 50k = 1.35M
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_late_penalties_reduce_attendance_block(operator, settings_obj):
    year, month = 2026, 3
    weekdays = _weekdays_of_month(year, month, day_off=6)
    # 3 опоздания × 50k = 150k штраф; остальные вовремя.
    for day in weekdays[:3]:
        _mklog(operator, date=day, hour=10, minute=25)  # 25мин > grace 20
    for day in weekdays[3:]:
        _mklog(operator, date=day, hour=10, minute=0)
    _make_sales(operator, year, month, Decimal("10000000"))

    summary = attendance_payroll_summary(operator, year, month)
    assert summary["attendance"]["gate_passed"] is True
    assert summary["attendance"]["days_late"] == 3
    assert Decimal(summary["attendance"]["late_penalty_total"]) == Decimal("150000")
    assert Decimal(summary["attendance"]["block_earned"]) == Decimal("1350000")
    assert Decimal(summary["total_earned"]) == Decimal("2850000")


# ---------------------------------------------------------------------------
# 5. Attendance 80% с опозданиями → penalty НЕ применяется (block уже 0)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_late_penalties_ignored_when_gate_fails(operator, settings_obj):
    year, month = 2026, 3
    weekdays = _weekdays_of_month(year, month, day_off=6)
    # 21/26 с опозданиями — гейт провален.
    for day in weekdays[:21]:
        _mklog(operator, date=day, hour=10, minute=25)

    summary = attendance_payroll_summary(operator, year, month)
    assert summary["attendance"]["gate_passed"] is False
    assert summary["attendance"]["block_earned"] == "0"
    # Штрафов быть не должно — гейт всё равно провален.
    assert summary["attendance"]["late_penalty_total"] == "0"


# ---------------------------------------------------------------------------
# 6. Sales 84.9% → gate_passed=false, shortfall > 0
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_sales_just_below_gate_fails(operator, settings_obj):
    year, month = 2026, 3
    weekdays = _weekdays_of_month(year, month, day_off=6)
    for day in weekdays:
        _mklog(operator, date=day, hour=10, minute=0)
    # 84% от 10M = 8.4M
    _make_sales(operator, year, month, Decimal("8400000"))

    summary = attendance_payroll_summary(operator, year, month)
    assert summary["sales"]["rate_pct"] == 84.0
    assert summary["sales"]["gate_passed"] is False
    assert summary["sales"]["block_earned"] == "0"
    # Shortfall = 8.5M - 8.4M = 100k
    assert Decimal(summary["sales"]["shortfall"]["amount_more_needed"]) == Decimal("100000")


# ---------------------------------------------------------------------------
# 7. Sales ровно 85% → gate_passed=true (round до сотых)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_sales_exactly_at_gate_passes(operator, settings_obj):
    year, month = 2026, 3
    weekdays = _weekdays_of_month(year, month, day_off=6)
    for day in weekdays:
        _mklog(operator, date=day, hour=10, minute=0)
    _make_sales(operator, year, month, Decimal("8500000"))

    summary = attendance_payroll_summary(operator, year, month)
    assert summary["sales"]["rate_pct"] == 85.0
    assert summary["sales"]["gate_passed"] is True
    assert summary["sales"]["block_earned"] == "1500000"


# ---------------------------------------------------------------------------
# 8. OperatorMonthlyPlan отсутствует → fallback на default_monthly_plan_uzs
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_missing_plan_falls_back_to_default(operator, settings_obj):
    year, month = 2026, 3
    weekdays = _weekdays_of_month(year, month, day_off=6)
    for day in weekdays:
        _mklog(operator, date=day, hour=10, minute=0)
    _make_sales(operator, year, month, Decimal("10000000"))
    # OperatorMonthlyPlan НЕ создан.

    summary = attendance_payroll_summary(operator, year, month)
    assert summary["sales"]["plan_source"] == "default_monthly_plan_uzs"
    assert summary["sales"]["plan_amount_uzs"] == "10000000"
    assert summary["sales"]["gate_passed"] is True


# ---------------------------------------------------------------------------
# 8b. OperatorMonthlyPlan задан → используется он, а не fallback
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_operator_monthly_plan_wins_over_default(operator, settings_obj):
    year, month = 2026, 3
    weekdays = _weekdays_of_month(year, month, day_off=6)
    for day in weekdays:
        _mklog(operator, date=day, hour=10, minute=0)
    # Личный план оператора — 15M (не 10M).
    OperatorMonthlyPlan.objects.create(
        operator=operator,
        year=year,
        month=month,
        target_amount=Decimal("15000000"),
    )
    # 12M / 15M = 80% — гейт провален (при default 10M было бы 120%).
    _make_sales(operator, year, month, Decimal("12000000"))

    summary = attendance_payroll_summary(operator, year, month)
    assert summary["sales"]["plan_source"] == "operator_monthly_plan"
    assert summary["sales"]["plan_amount_uzs"] == "15000000"
    assert summary["sales"]["gate_passed"] is False


# ---------------------------------------------------------------------------
# 9. Per-operator override attendance_bonus_uzs=2M → block меняется
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_per_operator_bonus_override(settings_obj):
    op = Operator.objects.create(
        full_name="Сеньор Оператор",
        status="active",
        attendance_bonus_uzs=Decimal("2000000"),
        sales_bonus_uzs=Decimal("2000000"),
    )
    year, month = 2026, 3
    weekdays = _weekdays_of_month(year, month, day_off=6)
    for day in weekdays:
        _mklog(op, date=day, hour=10, minute=0)
    _make_sales(op, year, month, Decimal("10000000"))

    summary = attendance_payroll_summary(op, year, month)
    assert summary["attendance_bonus_uzs"] == "2000000"
    assert summary["sales_bonus_uzs"] == "2000000"
    assert summary["attendance"]["block_earned"] == "2000000"
    assert summary["sales"]["block_earned"] == "2000000"
    assert summary["total_earned"] == "4000000"
    assert summary["max_possible"] == "4000000"


# ---------------------------------------------------------------------------
# 10. Legacy salary_uzs override — attendance-бонус берётся из него
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_legacy_salary_uzs_still_wins_as_attendance_bonus(settings_obj):
    """
    Оператор с legacy salary_uzs override — без нового
    attendance_bonus_uzs — читается как attendance-бонус (backward
    compat, чтобы менеджеры не переоткрывали каждую карточку).
    """
    op = Operator.objects.create(
        full_name="Ойбек Legacy",
        status="active",
        salary_uzs=Decimal("3000000"),
        # attendance_bonus_uzs НЕ задан.
    )
    year, month = 2026, 3
    weekdays = _weekdays_of_month(year, month, day_off=6)
    for day in weekdays:
        _mklog(op, date=day, hour=10, minute=0)

    summary = attendance_payroll_summary(op, year, month)
    assert summary["attendance_bonus_uzs"] == "3000000"
    assert summary["attendance"]["block_earned"] == "3000000"


# ---------------------------------------------------------------------------
# 11. Returned sales excluded (net-of-returns rule)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_returned_sales_excluded_from_sales_gate(operator, settings_obj):
    year, month = 2026, 3
    weekdays = _weekdays_of_month(year, month, day_off=6)
    for day in weekdays:
        _mklog(operator, date=day, hour=10, minute=0)

    tz = timezone.get_current_timezone()
    sold_at = dt.datetime(year, month, 5, 12, 0, tzinfo=tz)
    ch = _get_or_make_channel()
    # Одна валидная (5M) + одна returned (5M) — учитывается только 5M.
    good = Sale.objects.create(
        imei="000000000000001",
        phone_model="A",
        channel=ch,
        amount=Decimal("5000000"),
        sold_at=sold_at,
        status="confirmed",
    )
    SaleOperator.objects.create(sale=good, operator=operator, amount=Decimal("5000000"))
    bad = Sale.objects.create(
        imei="000000000000002",
        phone_model="B",
        channel=ch,
        amount=Decimal("5000000"),
        sold_at=sold_at,
        status="confirmed",
        is_returned=True,
    )
    SaleOperator.objects.create(sale=bad, operator=operator, amount=Decimal("5000000"))

    summary = attendance_payroll_summary(operator, year, month)
    # 5M / 10M = 50% < 85% → sales gate failed.
    assert Decimal(summary["sales"]["actual_uzs"]) == Decimal("5000000")
    assert summary["sales"]["gate_passed"] is False


# ---------------------------------------------------------------------------
# 12. Weekend / days-breakdown длина = месяц
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_days_breakdown_matches_month_length(operator, settings_obj):
    year, month = 2026, 3
    summary = attendance_payroll_summary(operator, year, month)
    _, last_day = calendar.monthrange(year, month)
    assert len(summary["attendance"]["days"]) == last_day
    # У марта 2026 — 5 воскресений.
    weekend_days = [d for d in summary["attendance"]["days"] if d["status"] == "weekend"]
    assert len(weekend_days) == 5


# ---------------------------------------------------------------------------
# 13. Per-operator sales_gate_pct override
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_per_operator_sales_gate_override(settings_obj):
    op = Operator.objects.create(
        full_name="Junior Оператор",
        status="active",
        sales_gate_pct=50,  # мягкий гейт для стажёра
    )
    year, month = 2026, 3
    weekdays = _weekdays_of_month(year, month, day_off=6)
    for day in weekdays:
        _mklog(op, date=day, hour=10, minute=0)
    _make_sales(op, year, month, Decimal("6000000"))  # 60% от 10M

    summary = attendance_payroll_summary(op, year, month)
    assert summary["sales_gate_pct"] == 50
    assert summary["sales"]["gate_passed"] is True
    assert summary["sales"]["block_earned"] == "1500000"

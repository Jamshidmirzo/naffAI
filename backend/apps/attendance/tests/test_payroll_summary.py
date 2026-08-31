"""
Тесты для `attendance_payroll_summary` (селектор attendance-based зарплаты).

Каждый тест мокает всего один-два фактора и проверяет ровно один кейс:
grace, absence deduction, late penalty, gate, per-operator override,
weekly free absence, weekend handling.

Все тайминги в Asia/Tashkent — `settings.TIME_ZONE`.
"""

from __future__ import annotations

import datetime as dt
from decimal import Decimal

import pytest
from django.utils import timezone

from apps.attendance.models import AttendanceLog, AttendanceSettings
from apps.attendance.selectors import (
    attendance_payroll_summary,
    attendance_settings_get,
)
from apps.operators.models import Operator


@pytest.fixture
def settings_obj(db):
    s = attendance_settings_get()
    # Убеждаемся, что дефолты как в плане.
    s.shift_start = dt.time(10, 0)
    s.shift_end = dt.time(20, 0)
    s.default_salary_uzs = Decimal("1500000")
    s.default_grace_period_min = 20
    s.default_late_penalty_uzs = Decimal("50000")
    s.default_weekly_day_off = 6  # Вс
    s.default_attendance_gate_pct = 85
    s.default_weekly_free_absences = 1
    s.save()
    return s


@pytest.fixture
def operator(db):
    return Operator.objects.create(full_name="Тест Оплата", status="active")


def _mklog(
    operator: Operator, *, date: dt.date, hour: int, minute: int
) -> AttendanceLog:
    """Создаёт AttendanceLog c check_in в локальном (Ташкент) времени."""
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
    import calendar

    _, last_day = calendar.monthrange(year, month)
    return [
        dt.date(year, month, d)
        for d in range(1, last_day + 1)
        if dt.date(year, month, d).weekday() != day_off
    ]


@pytest.mark.django_db
def test_perfect_attendance_earns_full_salary(operator, settings_obj):
    """
    Оператор посещал все рабочие дни, каждый — в 10:00 → нет опозданий,
    нет пропусков. `salary_earned == salary_gross`.
    """
    year, month = 2026, 3  # март 2026, weekday_day_off=6 (Вс)
    for day in _weekdays_of_month(year, month, day_off=6):
        _mklog(operator, date=day, hour=10, minute=0)

    summary = attendance_payroll_summary(operator, year, month)
    assert summary["days_attended"] == summary["working_days_planned"]
    assert summary["days_late"] == 0
    assert summary["days_absent"] == 0
    assert summary["absence_deduction"] == "0"
    assert summary["late_penalty_total"] == "0"
    assert summary["salary_earned"] == "1500000"
    assert summary["gate_triggered"] is False


@pytest.mark.django_db
def test_one_absence_within_weekly_free_is_not_billed(operator, settings_obj):
    """1 пропуск в неделю → free_absence, вычета нет."""
    year, month = 2026, 3
    weekdays = _weekdays_of_month(year, month, day_off=6)
    # Посещаем всё кроме первого рабочего дня месяца.
    for day in weekdays[1:]:
        _mklog(operator, date=day, hour=10, minute=0)

    summary = attendance_payroll_summary(operator, year, month)
    assert summary["days_absent"] == 1
    assert summary["weekly_free_absences_used"] == 1
    assert summary["billable_absences"] == 0
    assert summary["absence_deduction"] == "0"
    assert summary["salary_earned"] == "1500000"


@pytest.mark.django_db
def test_multiple_absences_across_weeks_deduct_daily_rate(operator, settings_obj):
    """
    3 пропуска в 3 разных ISO-неделях → каждая свою «free» и списывать
    начинает только со 2-го пропуска в конкретной неделе. Здесь все 3 →
    все 3 «free», billable=0.
    """
    year, month = 2026, 3
    weekdays = _weekdays_of_month(year, month, day_off=6)
    # Пропустим три случайных дня из разных недель.
    from apps.attendance.utils import week_bucket

    grouped: dict = {}
    for d in weekdays:
        grouped.setdefault(week_bucket(d), []).append(d)
    # Возьмём одну дату из каждой из первых 3 недель.
    skip = [days[0] for _, days in list(grouped.items())[:3]]
    for day in weekdays:
        if day in skip:
            continue
        _mklog(operator, date=day, hour=10, minute=0)

    summary = attendance_payroll_summary(operator, year, month)
    assert summary["days_absent"] == 3
    # По 1 free в каждой из 3 недель → всё free, billable=0.
    assert summary["weekly_free_absences_used"] == 3
    assert summary["billable_absences"] == 0


@pytest.mark.django_db
def test_two_absences_same_week_one_is_billable(operator, settings_obj):
    """2 пропуска в ОДНУ неделю → 1 free + 1 billable → −daily_rate."""
    year, month = 2026, 3
    weekdays = _weekdays_of_month(year, month, day_off=6)
    # Первые 2 рабочих дня месяца (март 2026 нач. с воскресенья 1-го,
    # значит weekdays[0]=Пн 2 мар, weekdays[1]=Вт 3 мар — одна ISO-неделя).
    skip = weekdays[:2]
    for day in weekdays:
        if day in skip:
            continue
        _mklog(operator, date=day, hour=10, minute=0)

    summary = attendance_payroll_summary(operator, year, month)
    assert summary["days_absent"] == 2
    assert summary["weekly_free_absences_used"] == 1
    assert summary["billable_absences"] == 1
    assert Decimal(summary["absence_deduction"]) == Decimal(summary["daily_rate"])
    # salary_earned = 1_500_000 - daily_rate
    expected = Decimal("1500000") - Decimal(summary["daily_rate"])
    assert Decimal(summary["salary_earned"]) == expected


@pytest.mark.django_db
def test_late_arrival_within_grace_is_on_time(operator, settings_obj):
    """Приход в 10:15 при grace=20мин → on_time, штрафа нет."""
    year, month = 2026, 3
    weekdays = _weekdays_of_month(year, month, day_off=6)
    # Каждый день в 10:15 (5 мин сверх shift, но в grace).
    for day in weekdays:
        _mklog(operator, date=day, hour=10, minute=15)

    summary = attendance_payroll_summary(operator, year, month)
    assert summary["days_late"] == 0
    assert summary["late_penalty_total"] == "0"
    assert summary["salary_earned"] == "1500000"


@pytest.mark.django_db
def test_late_beyond_grace_incurs_penalty(operator, settings_obj):
    """Приход в 10:25 = 5мин сверх grace 20мин → late + −50k каждый раз."""
    year, month = 2026, 3
    weekdays = _weekdays_of_month(year, month, day_off=6)
    for day in weekdays[:5]:
        _mklog(operator, date=day, hour=10, minute=25)
    for day in weekdays[5:]:
        _mklog(operator, date=day, hour=10, minute=0)

    summary = attendance_payroll_summary(operator, year, month)
    assert summary["days_late"] == 5
    assert Decimal(summary["late_penalty_total"]) == Decimal("50000") * 5
    expected = Decimal("1500000") - Decimal("250000")
    assert Decimal(summary["salary_earned"]) == expected


@pytest.mark.django_db
def test_gate_triggered_zeroes_out_salary(operator, settings_obj):
    """Посещаемость <85% → gate_triggered → salary_earned=0."""
    year, month = 2026, 3
    weekdays = _weekdays_of_month(year, month, day_off=6)
    # Посетил только 50% дней.
    half = len(weekdays) // 2
    for day in weekdays[:half]:
        _mklog(operator, date=day, hour=10, minute=0)

    summary = attendance_payroll_summary(operator, year, month)
    assert summary["gate_triggered"] is True
    assert summary["salary_earned"] == "0"


@pytest.mark.django_db
def test_per_operator_salary_override(settings_obj):
    """Оператор с override salary_uzs=3M — берётся его, не default."""
    op = Operator.objects.create(
        full_name="Стажёр Ойбек",
        status="active",
        salary_uzs=Decimal("3000000"),
    )
    year, month = 2026, 3
    weekdays = _weekdays_of_month(year, month, day_off=6)
    for day in weekdays:
        _mklog(op, date=day, hour=10, minute=0)

    summary = attendance_payroll_summary(op, year, month)
    assert summary["salary_gross"] == "3000000"
    assert summary["salary_earned"] == "3000000"


@pytest.mark.django_db
def test_per_operator_shift_start_override(settings_obj):
    """Оператор с shift_start=14:00 — приход в 14:10 = on_time (в grace 20)."""
    op = Operator.objects.create(
        full_name="Студент Дилшод",
        status="active",
        shift_start=dt.time(14, 0),
        shift_end=dt.time(20, 0),
    )
    year, month = 2026, 3
    weekdays = _weekdays_of_month(year, month, day_off=6)
    for day in weekdays:
        _mklog(op, date=day, hour=14, minute=10)

    summary = attendance_payroll_summary(op, year, month)
    assert summary["days_late"] == 0


@pytest.mark.django_db
def test_weekend_never_counts_as_absent(operator, settings_obj):
    """Личный выходной (Вс) → status=weekend, не absent."""
    year, month = 2026, 3
    weekdays = _weekdays_of_month(year, month, day_off=6)
    for day in weekdays:
        _mklog(operator, date=day, hour=10, minute=0)

    summary = attendance_payroll_summary(operator, year, month)
    # У марта 2026 — 5 воскресений (1, 8, 15, 22, 29).
    weekend_days = [d for d in summary["days"] if d["status"] == "weekend"]
    assert len(weekend_days) == 5
    # Ни один воскресенье не даёт absent.
    absent = [d for d in summary["days"] if d["status"] == "absent"]
    assert len(absent) == 0


@pytest.mark.django_db
def test_per_operator_weekly_day_off_override(settings_obj):
    """Оператор с weekly_day_off=5 (Сб). Работаем в Вс → Вс становится будним."""
    op = Operator.objects.create(
        full_name="Ойбек Субботный",
        status="active",
        weekly_day_off=5,  # Сб
    )
    year, month = 2026, 3
    # Считаем «рабочие» = все дни кроме Сб.
    weekdays = _weekdays_of_month(year, month, day_off=5)
    for day in weekdays:
        _mklog(op, date=day, hour=10, minute=0)

    summary = attendance_payroll_summary(op, year, month)
    assert summary["weekly_day_off"] == 5
    # Вс должно стать рабочим (не weekend).
    sundays = [d for d in summary["days"] if dt.date.fromisoformat(d["date"]).weekday() == 6]
    for d in sundays:
        assert d["status"] != "weekend"


@pytest.mark.django_db
def test_days_breakdown_length_matches_month(operator, settings_obj):
    """`days[]` содержит по 1 записи на каждый календарный день месяца."""
    import calendar

    year, month = 2026, 3
    summary = attendance_payroll_summary(operator, year, month)
    _, last_day = calendar.monthrange(year, month)
    assert len(summary["days"]) == last_day

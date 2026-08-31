"""
Pure calendar helpers used by the payroll selector.

Все функции работают в терминах локальных `datetime.date` (без timezone).
`week_bucket` использует ISO-неделю (пн-вс) — так «1 free absence в неделю»
ложится ровно на календарную неделю, а не на скользящее окно 7 дней.
"""

from __future__ import annotations

import calendar
import datetime as dt


def is_working_day(day: dt.date, weekly_day_off: int) -> bool:
    """
    True если `day` — рабочий (не совпадает с личным выходным оператора).
    `weekly_day_off` в формате Python `date.weekday()` — 0=Пн … 6=Вс.
    """
    return day.weekday() != int(weekly_day_off)


def working_days_in_month(year: int, month: int, weekly_day_off: int) -> list[dt.date]:
    """
    Список всех рабочих дней (без личного выходного) внутри календарного
    месяца. Никаких праздников — MVP не хранит календарь UZ праздников,
    посещаемость считается «был / не был», а праздничные дни фиксируются
    как обычные absent (менеджер может простить через weekly-free-абсенс
    или руками в будущей version).
    """
    _, last_day = calendar.monthrange(int(year), int(month))
    out: list[dt.date] = []
    for d in range(1, last_day + 1):
        day = dt.date(int(year), int(month), d)
        if is_working_day(day, weekly_day_off):
            out.append(day)
    return out


def week_bucket(day: dt.date) -> tuple[int, int]:
    """
    ISO-ключ недели (`(iso_year, iso_week)`) — стабильно и на границах
    года. Используется группировкой для лимита `weekly_free_absences`.
    Например 1 января 2024 попадает в ISO-неделю 2024-01, а 31 декабря
    2023 может уехать в 2023-52 (реже — 2024-01 если это чтв-вск).
    """
    iso_year, iso_week, _iso_weekday = day.isocalendar()
    return (int(iso_year), int(iso_week))

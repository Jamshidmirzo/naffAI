"""
Detectors уважают per-operator `shift_start` / `shift_end`.

Кейс от пользователя: оператор с личной сменой 12:00–22:00, check-in в
11:50. Глобальный shift_start=10:00 → по глобалу «опоздание +1ч 35мин»,
по личной смене — check-in ДО начала смены (был_late должен быть
False).
"""

from __future__ import annotations

import datetime as dt

import pytest
from django.utils import timezone
from freezegun import freeze_time

from apps.attendance.models import AttendanceSettings
from apps.attendance.services import _attendance_check_in
from apps.operators.models import Operator, OperatorStatus

# Все тесты замораживаем на 11:00 утра Ташкента (06:00 UTC): «сейчас ± 1
# час» не должен перепрыгивать полночь — иначе `.time()` от завтрашних
# 00:30 превращается в «сегодня 00:30 = давно прошло» и тест флакует
# при ночных прогонах.
_FROZEN = "2026-09-04 06:00:00"  # 11:00 Asia/Tashkent


@pytest.mark.django_db
@freeze_time(_FROZEN)
def test_check_in_uses_operator_shift_start_not_global():
    """Оператор с личной сменой 12:00 → check-in ~11:50 не «опоздал»,
    даже если глобальный shift_start=10:00.

    Технически: мокаем `timezone.now()` через freeze аналог — ставим
    операторский shift_start на «через час от сейчас», глобальный —
    «на час назад от сейчас». Ожидаем was_late=False."""

    now_local = timezone.localtime(timezone.now())
    # Глобальная смена «уже давно должна была начаться»
    global_start = (now_local - dt.timedelta(hours=1)).time().replace(microsecond=0)
    # Личная смена оператора «начнётся через час»
    op_start = (now_local + dt.timedelta(hours=1)).time().replace(microsecond=0)

    s, _ = AttendanceSettings.objects.get_or_create(pk=1)
    s.shift_start = global_start
    s.late_threshold_min = 15
    s.save()

    op = Operator.objects.create(
        full_name="Late-shift Op",
        status=OperatorStatus.ACTIVE,
        shift_start=op_start,
    )

    result = _attendance_check_in(
        operator=op,
        source="test",
        initiator=None,
        ip="127.0.0.1",
        user_agent="pytest",
        issue_token=False,
        settings_obj=s,
    )

    # Личная смена ещё не началась → это ранний приход, не опоздание.
    assert result["action"] == "check_in"
    assert result["was_late"] is False


@pytest.mark.django_db
@freeze_time(_FROZEN)
def test_check_in_falls_back_to_global_shift_when_op_has_none():
    """Оператор без личного shift_start → используется глобальный.

    Проверяем регрессию: не поломали дефолтный путь per-op override."""

    now_local = timezone.localtime(timezone.now())
    # Ставим глобальный старт на «час назад» + threshold 0 → должен
    # выпасть was_late=True.
    global_start = (now_local - dt.timedelta(hours=1)).time().replace(microsecond=0)

    s, _ = AttendanceSettings.objects.get_or_create(pk=1)
    s.shift_start = global_start
    s.late_threshold_min = 0
    s.save()

    op = Operator.objects.create(
        full_name="Default-shift Op",
        status=OperatorStatus.ACTIVE,
        shift_start=None,  # явно — берём глобальный
    )

    result = _attendance_check_in(
        operator=op,
        source="test",
        initiator=None,
        ip="127.0.0.1",
        user_agent="pytest",
        issue_token=False,
        settings_obj=s,
    )

    assert result["was_late"] is True

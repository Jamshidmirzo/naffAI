"""
Write-side для attendance-PIN-gate.

Модель PIN'a (2026-08-15 redesign):

- **Один общий PIN на всех менеджеров** — хранится в singleton'e
  `AttendanceSettings.pin_hash`. Все менеджеры вводят одну и ту же
  4-значную комбинацию. Superadmin — единственный кто может задать /
  сменить / сбросить PIN. Superadmin сам PIN'a не вводит (bypass).

- `attendance_pin_set(actor, new_pin)` — только superadmin, ставит новый
  глобальный PIN. Не требует `old_pin` (superadmin имеет право менять
  всегда, поле «текущий пароль» бесполезно, т.к. у него в UI и так
  bypass). При смене инвалидирует ВСЕ активные `PinSession` — все
  менеджеры должны заново ввести новый PIN.

- `attendance_pin_verify(user, pin)` — любой senior (кроме операторов),
  сравнивает с глобальным PIN'ом, при успехе upsert-ит personal
  `AttendancePinSession(user, verified_at=now())`, чтобы permission
  пропускал юзера на TTL.

- `attendance_pin_reset(actor)` — только superadmin, вычищает
  `AttendanceSettings.pin_hash` + удаляет ВСЕ `PinSession`. После этого
  никто не сможет войти в attendance-раздел (кроме superadmin), пока он
  же не задаст новый PIN.

Все три write-операции пишут аудит-лог без сохранения plaintext'a.
"""

from __future__ import annotations

import datetime as dt
import re

from django.contrib.auth import get_user_model
from django.contrib.auth.hashers import check_password, make_password
from django.db import transaction
from django.utils import timezone
from rest_framework.exceptions import ValidationError

from apps.audit.services import AuditAction, audit_log_create

from .models import AttendancePinSession, AttendanceSettings

User = get_user_model()

# 30 минут — стандартный TTL сессии. Держим здесь константой, чтобы
# permission-класс, verify и /status/ смотрели в один источник.
PIN_TTL = dt.timedelta(minutes=30)

_PIN_RE = re.compile(r"^\d{4}$")


class AttendancePinAction:
    SET = "attendance_pin_set"
    RESET = "attendance_pin_reset"


def _validate_pin(pin: str) -> None:
    if not isinstance(pin, str) or not _PIN_RE.match(pin):
        raise ValidationError({"pin": "PIN должен быть ровно из 4 цифр"})


def _settings() -> AttendanceSettings:
    """Singleton getter — pk всегда 1, создаём если нет."""
    obj, _ = AttendanceSettings.objects.get_or_create(pk=1)
    return obj


@transaction.atomic
def attendance_pin_set(*, actor: User, new_pin: str) -> AttendanceSettings:
    """
    Задаёт/меняет глобальный attendance-PIN. Разрешено только superadmin'у
    (гард — во view, здесь дублирующей проверки нет: сервис принимает
    actor только чтобы записать его в `pin_updated_by` и аудит).

    Инвалидирует все существующие `AttendancePinSession` — после смены
    PIN'a все менеджеры должны заново ввести новую комбинацию.
    """
    _validate_pin(new_pin)

    settings_obj = _settings()
    settings_obj.pin_hash = make_password(new_pin)
    settings_obj.pin_updated_at = timezone.now()
    settings_obj.pin_updated_by = actor
    settings_obj.save(update_fields=["pin_hash", "pin_updated_at", "pin_updated_by"])

    AttendancePinSession.objects.all().delete()

    audit_log_create(
        user=actor,
        action=AuditAction.UPDATE,
        entity="attendance.AttendanceSettings",
        entity_id=settings_obj.pk,
        changes={"attendance_pin": "set"},
    )
    return settings_obj


@transaction.atomic
def attendance_pin_verify(*, user: User, pin: str) -> AttendancePinSession:
    """
    Проверяет PIN против глобального `AttendanceSettings.pin_hash`. При
    успехе upsert-ит personal `AttendancePinSession(user, verified_at=now)`
    — permission-класс `IsAttendancePinVerified` будет пропускать этого
    юзера на TTL.
    """
    _validate_pin(pin)
    settings_obj = _settings()

    if not settings_obj.pin_hash:
        raise ValidationError({"pin": "PIN ещё не задан суперадмином"})

    if not check_password(pin, settings_obj.pin_hash):
        raise ValidationError({"pin": "Неверный PIN"})

    session, _ = AttendancePinSession.objects.update_or_create(
        user=user,
        defaults={"verified_at": timezone.now()},
    )
    return session


@transaction.atomic
def attendance_pin_reset(*, actor: User) -> AttendanceSettings:
    """
    Сбрасывает глобальный PIN: чистит hash + убивает все PinSession.
    Разрешено только superadmin'у (гард — во view).

    После сброса все менеджеры получают 401 pin_required на любой
    attendance endpoint, а форма ввода PIN'a показывает «PIN не задан,
    обратитесь к суперадмину».
    """
    settings_obj = _settings()
    settings_obj.pin_hash = ""
    settings_obj.pin_updated_at = timezone.now()
    settings_obj.pin_updated_by = actor
    settings_obj.save(update_fields=["pin_hash", "pin_updated_at", "pin_updated_by"])
    AttendancePinSession.objects.all().delete()

    audit_log_create(
        user=actor,
        action=AuditAction.UPDATE,
        entity="attendance.AttendanceSettings",
        entity_id=settings_obj.pk,
        changes={"attendance_pin": "reset"},
    )
    return settings_obj


def attendance_pin_is_set() -> bool:
    """True если глобальный PIN задан (superadmin его установил)."""
    settings_obj = AttendanceSettings.objects.filter(pk=1).only("pin_hash").first()
    return bool(settings_obj and settings_obj.pin_hash)


def attendance_pin_session_is_valid(user: User) -> bool:
    """
    True если у user есть PinSession и она не старше `PIN_TTL`. Используется
    permission-классом. Не создаёт объектов, не пишет аудит — чистый read.

    Читаем через фильтр, а не через OneToOne reverse — иначе кеш ORM
    отдаёт устаревшую строку, если сессию mutate-нули извне (тесты,
    parallel request).
    """
    session = AttendancePinSession.objects.filter(user=user).only("verified_at").first()
    if session is None:
        return False
    return (timezone.now() - session.verified_at) <= PIN_TTL


def attendance_pin_session_expires_at(user: User) -> dt.datetime | None:
    """`verified_at + PIN_TTL` или None если сессии нет."""
    session = AttendancePinSession.objects.filter(user=user).only("verified_at").first()
    if session is None:
        return None
    return session.verified_at + PIN_TTL


def attendance_pin_meta() -> dict:
    """Метаданные для /status/ и страницы настроек — когда и кем последний раз обновлён."""
    settings_obj = (
        AttendanceSettings.objects.filter(pk=1)
        .select_related("pin_updated_by")
        .only("pin_hash", "pin_updated_at", "pin_updated_by__username")
        .first()
    )
    if settings_obj is None:
        return {"has_pin": False, "updated_at": None, "updated_by": None}
    return {
        "has_pin": bool(settings_obj.pin_hash),
        "updated_at": (
            settings_obj.pin_updated_at.isoformat()
            if settings_obj.pin_updated_at
            else None
        ),
        "updated_by": (
            settings_obj.pin_updated_by.username
            if settings_obj.pin_updated_by_id
            else None
        ),
    }


__all__ = [
    "PIN_TTL",
    "AttendancePinAction",
    "attendance_pin_set",
    "attendance_pin_verify",
    "attendance_pin_reset",
    "attendance_pin_is_set",
    "attendance_pin_session_is_valid",
    "attendance_pin_session_expires_at",
    "attendance_pin_meta",
]

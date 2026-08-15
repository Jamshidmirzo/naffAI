"""
Write-side для attendance-PIN-gate.

- `attendance_pin_set` — задаёт/меняет PIN менеджера. Если PIN уже был,
  требует `old_pin`. Superadmin вправе задать PIN другому менеджеру без
  `old_pin` (не используется в UI — reset через `attendance_pin_reset`).
- `attendance_pin_verify` — проверяет PIN, при успехе обновляет
  `AttendancePinSession.verified_at=now()`, чтобы permission-класс
  пропустил менеджера на 30 минут.
- `attendance_pin_reset` — сбрасывает hash + удаляет сессию; только
  superadmin (проверка ролей — во view).

Все операции пишут аудит-лог (без сохранения самого PIN'a).
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
from apps.users.models import Profile, Role

from .models import AttendancePinSession

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


def _profile_for(user: User) -> Profile:
    profile = getattr(user, "profile", None)
    if profile is None:
        # Технически возможно у пользователей, созданных до появления
        # Profile; страхуемся.
        profile, _ = Profile.objects.get_or_create(user=user)
    return profile


@transaction.atomic
def attendance_pin_set(
    *,
    user: User,
    new_pin: str,
    old_pin: str | None = None,
) -> None:
    """
    Задаёт/меняет PIN текущего пользователя. Если PIN уже был — требует
    правильный `old_pin`. Всегда пишет audit.

    Никогда не сохраняет plaintext в audit — только сам факт события.
    """
    _validate_pin(new_pin)
    profile = _profile_for(user)

    if profile.attendance_pin_hash:
        if not old_pin or not check_password(old_pin, profile.attendance_pin_hash):
            raise ValidationError({"old_pin": "Неверный текущий PIN"})

    profile.attendance_pin_hash = make_password(new_pin)
    profile.save(update_fields=["attendance_pin_hash"])

    # После смены PIN'a старая сессия недействительна — заставляем ввести
    # ещё раз (иначе логика "поменял PIN и продолжил без ввода" тоже
    # ломает намерение фичи).
    AttendancePinSession.objects.filter(user=user).delete()

    audit_log_create(
        user=user,
        action=AuditAction.UPDATE,
        entity="users.Profile",
        entity_id=profile.pk,
        changes={"attendance_pin": "set"},
    )


@transaction.atomic
def attendance_pin_verify(*, user: User, pin: str) -> AttendancePinSession:
    """
    Проверяет PIN. При успехе upsert-ит `AttendancePinSession` c
    `verified_at=now()`. Возвращает свежую сессию.
    """
    _validate_pin(pin)
    profile = _profile_for(user)

    if not profile.attendance_pin_hash:
        raise ValidationError({"pin": "PIN ещё не задан"})

    if not check_password(pin, profile.attendance_pin_hash):
        raise ValidationError({"pin": "Неверный PIN"})

    session, _ = AttendancePinSession.objects.update_or_create(
        user=user,
        defaults={"verified_at": timezone.now()},
    )
    return session


@transaction.atomic
def attendance_pin_reset(*, actor: User, target: User) -> None:
    """
    Сбрасывает PIN у `target` — вычищает hash и убивает сессию.
    Проверка «actor.role == superadmin» — ответственность вью.
    """
    profile = _profile_for(target)
    profile.attendance_pin_hash = ""
    profile.save(update_fields=["attendance_pin_hash"])
    AttendancePinSession.objects.filter(user=target).delete()

    audit_log_create(
        user=actor,
        action=AuditAction.UPDATE,
        entity="users.Profile",
        entity_id=profile.pk,
        changes={"attendance_pin": "reset", "target_user_id": target.id},
    )


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


__all__ = [
    "PIN_TTL",
    "AttendancePinAction",
    "attendance_pin_set",
    "attendance_pin_verify",
    "attendance_pin_reset",
    "attendance_pin_session_is_valid",
    "attendance_pin_session_expires_at",
]

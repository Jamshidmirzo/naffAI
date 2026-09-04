"""
API-тесты личного расписания оператора (`PATCH /api/operators/{pk}/`).

Проверяем 3 инварианта:

  1. Manager может задать `shift_start`/`shift_end`/`weekly_day_off` +
     `grace_period_min`/`weekly_free_absences`, PATCH сохраняется в DB,
     GET возвращает те же значения.
  2. Manager может СБРОСИТЬ персональное значение обратно в default,
     передав null — поле в DB становится NULL (backend `resolve_operator_
     config` возьмёт значение из AttendanceSettings).
  3. Оператор НЕ может править чужое расписание (`OperatorDetailApi` под
     `IsTeamLead` → operator-роль получает 403). Он в принципе не может
     трогать `/api/operators/{pk}/` — эта проверка защищает от регрессии,
     если кто-то ослабит permission.

NB: используем APIClient + force_authenticate — без прохода через
username/password, чтобы тесты были быстрыми и не зависели от
attendance PIN gate (он висит только на attendance-endpoint'ах).
"""

from __future__ import annotations

import datetime as dt

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from apps.operators.models import Operator
from apps.users.models import Profile, Role


User = get_user_model()


@pytest.fixture
def api_client():
    return APIClient()


@pytest.fixture
def operator_a(db):
    return Operator.objects.create(full_name="Alice Schedule", status="active")


@pytest.fixture
def operator_b(db):
    return Operator.objects.create(full_name="Bob Schedule", status="active")


@pytest.fixture
def manager_user(db):
    u = User.objects.create_user(username="mgr_sched", password="x")
    Profile.objects.create(user=u, role=Role.MANAGER)
    return u


@pytest.fixture
def operator_user(db, operator_b):
    u = User.objects.create_user(username="op_sched", password="x")
    Profile.objects.create(user=u, role=Role.OPERATOR, operator=operator_b)
    return u


# --------------------------------------------------------------------------
# 1. Manager writes personal schedule
# --------------------------------------------------------------------------


@pytest.mark.django_db
def test_manager_can_set_personal_shift_start(api_client, manager_user, operator_a):
    """PATCH shift_start='12:00' сохраняется + GET возвращает то же."""
    api_client.force_authenticate(manager_user)
    r = api_client.patch(
        f"/api/operators/{operator_a.id}/",
        {"shift_start": "12:00", "shift_end": "20:00"},
        format="json",
    )
    assert r.status_code == 200, r.content
    operator_a.refresh_from_db()
    assert operator_a.shift_start == dt.time(12, 0)
    assert operator_a.shift_end == dt.time(20, 0)

    # GET back — оба поля возвращаются в HH:MM:SS форме (Django TimeField
    # default). Фронт обрезает до HH:MM при рендере <input type="time">.
    r2 = api_client.get(f"/api/operators/{operator_a.id}/")
    assert r2.status_code == 200
    body = r2.json()
    assert body["shift_start"] in ("12:00:00", "12:00")
    assert body["shift_end"] in ("20:00:00", "20:00")


@pytest.mark.django_db
def test_manager_can_set_grace_and_day_off(api_client, manager_user, operator_a):
    """PATCH grace_period_min + weekly_day_off + weekly_free_absences."""
    api_client.force_authenticate(manager_user)
    r = api_client.patch(
        f"/api/operators/{operator_a.id}/",
        {
            "grace_period_min": 30,
            "weekly_day_off": 6,  # Sunday
            "weekly_free_absences": 2,
        },
        format="json",
    )
    assert r.status_code == 200, r.content
    operator_a.refresh_from_db()
    assert operator_a.grace_period_min == 30
    assert operator_a.weekly_day_off == 6
    assert operator_a.weekly_free_absences == 2


# --------------------------------------------------------------------------
# 2. Reset override → null
# --------------------------------------------------------------------------


@pytest.mark.django_db
def test_manager_can_reset_shift_to_default(api_client, manager_user, operator_a):
    """PATCH shift_start=null очищает override → DB видит NULL."""
    operator_a.shift_start = dt.time(11, 30)
    operator_a.shift_end = dt.time(19, 30)
    operator_a.save(update_fields=["shift_start", "shift_end"])

    api_client.force_authenticate(manager_user)
    r = api_client.patch(
        f"/api/operators/{operator_a.id}/",
        {"shift_start": None, "shift_end": None},
        format="json",
    )
    assert r.status_code == 200, r.content
    operator_a.refresh_from_db()
    assert operator_a.shift_start is None
    assert operator_a.shift_end is None


# --------------------------------------------------------------------------
# 3. Operator cannot edit anyone
# --------------------------------------------------------------------------


@pytest.mark.django_db
def test_operator_cannot_patch_another_operator_schedule(
    api_client, operator_user, operator_a
):
    """Operator PATCH-ит расписание другого оператора → 403.

    Guard от регрессии: `OperatorDetailApi.permission_classes = [IsTeamLead]`.
    Если кто-то случайно ослабит permission — operator получит доступ к
    правке чужих смен, что недопустимо. Тест ловит это на CI.
    """
    api_client.force_authenticate(operator_user)
    r = api_client.patch(
        f"/api/operators/{operator_a.id}/",
        {"shift_start": "06:00"},
        format="json",
    )
    assert r.status_code == 403, r.content
    operator_a.refresh_from_db()
    # Ничего не изменилось.
    assert operator_a.shift_start is None


@pytest.mark.django_db
def test_operator_cannot_patch_own_schedule_via_operators_api(
    api_client, operator_user, operator_b
):
    """
    Даже свой Operator — PATCH через `/api/operators/{pk}/` запрещён для
    роли operator. Настройки уровня оператора живут отдельно
    (`/api/me/preferences/` — но там только daily_lesson_opt_out, не
    расписание). Это подтверждает, что расписание — прерогатива менеджера.
    """
    api_client.force_authenticate(operator_user)
    r = api_client.patch(
        f"/api/operators/{operator_b.id}/",
        {"shift_start": "06:00"},
        format="json",
    )
    assert r.status_code == 403, r.content

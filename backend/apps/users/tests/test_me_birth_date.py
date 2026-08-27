"""
PATCH /api/auth/me/ — оператор редактирует свою дату рождения.
GET  /api/auth/me/ — возвращает `birth_date` + `is_birthday_today`.
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
def op(db):
    return Operator.objects.create(
        full_name="Оп Опов", status="active", phone="+998900000011"
    )


@pytest.fixture
def operator_user(db, op):
    u = User.objects.create_user(username="+998900000011", password="x", is_active=True)
    Profile.objects.create(user=u, role=Role.OPERATOR, operator=op)
    return u


@pytest.fixture
def manager_user(db):
    u = User.objects.create_user(username="mgr", password="x", is_active=True)
    Profile.objects.create(user=u, role=Role.MANAGER)
    return u


@pytest.mark.django_db
def test_get_me_returns_birth_date_and_flag(api_client, operator_user, op):
    op.birth_date = dt.date.today().replace(year=1990)
    op.save(update_fields=["birth_date"])

    api_client.force_authenticate(operator_user)
    r = api_client.get("/api/auth/me/")
    assert r.status_code == 200
    data = r.json()
    assert data["birth_date"] == op.birth_date.isoformat()
    assert data["is_birthday_today"] is True


@pytest.mark.django_db
def test_get_me_no_bd_flag_is_false(api_client, operator_user):
    api_client.force_authenticate(operator_user)
    r = api_client.get("/api/auth/me/")
    assert r.status_code == 200
    assert r.json()["birth_date"] is None
    assert r.json()["is_birthday_today"] is False


@pytest.mark.django_db
def test_operator_can_set_own_birth_date(api_client, operator_user, op):
    api_client.force_authenticate(operator_user)
    r = api_client.patch(
        "/api/auth/me/", {"birth_date": "1995-04-20"}, format="json"
    )
    assert r.status_code == 200, r.content
    op.refresh_from_db()
    assert op.birth_date == dt.date(1995, 4, 20)


@pytest.mark.django_db
def test_operator_can_clear_own_birth_date(api_client, operator_user, op):
    op.birth_date = dt.date(1995, 4, 20)
    op.save(update_fields=["birth_date"])

    api_client.force_authenticate(operator_user)
    r = api_client.patch("/api/auth/me/", {"birth_date": None}, format="json")
    assert r.status_code == 200
    op.refresh_from_db()
    assert op.birth_date is None


@pytest.mark.django_db
def test_future_date_rejected(api_client, operator_user, op):
    future = (dt.date.today() + dt.timedelta(days=30)).isoformat()
    api_client.force_authenticate(operator_user)
    r = api_client.patch("/api/auth/me/", {"birth_date": future}, format="json")
    assert r.status_code == 400
    op.refresh_from_db()
    assert op.birth_date is None


@pytest.mark.django_db
def test_year_too_old_rejected(api_client, operator_user, op):
    api_client.force_authenticate(operator_user)
    r = api_client.patch("/api/auth/me/", {"birth_date": "1900-01-01"}, format="json")
    assert r.status_code == 400
    op.refresh_from_db()
    assert op.birth_date is None


@pytest.mark.django_db
def test_bad_format_rejected(api_client, operator_user, op):
    api_client.force_authenticate(operator_user)
    r = api_client.patch("/api/auth/me/", {"birth_date": "20/04/1995"}, format="json")
    assert r.status_code == 400


@pytest.mark.django_db
def test_manager_cannot_set_own_birth_date_via_me(api_client, manager_user):
    """У менеджера нет operator FK → 400 при попытке задать birth_date."""
    api_client.force_authenticate(manager_user)
    r = api_client.patch(
        "/api/auth/me/", {"birth_date": "1990-01-01"}, format="json"
    )
    assert r.status_code == 400
    assert "birth_date" in r.json()


@pytest.mark.django_db
def test_language_and_birth_date_can_be_patched_together(api_client, operator_user, op):
    api_client.force_authenticate(operator_user)
    r = api_client.patch(
        "/api/auth/me/",
        {"preferred_language": "ru", "birth_date": "1995-04-20"},
        format="json",
    )
    assert r.status_code == 200
    data = r.json()
    assert data["preferred_language"] == "ru"
    assert data["birth_date"] == "1995-04-20"
    op.refresh_from_db()
    assert op.birth_date == dt.date(1995, 4, 20)


@pytest.mark.django_db
def test_setting_new_day_month_resets_notified_guard(api_client, operator_user, op):
    """Меняем ДР на другой день → сбрасываем idempotency guard."""
    op.birth_date = dt.date(1990, 6, 15)
    op.birthday_notified_on = dt.date.today()
    op.save(update_fields=["birth_date", "birthday_notified_on"])

    api_client.force_authenticate(operator_user)
    r = api_client.patch(
        "/api/auth/me/", {"birth_date": "1990-07-20"}, format="json"
    )
    assert r.status_code == 200
    op.refresh_from_db()
    assert op.birth_date == dt.date(1990, 7, 20)
    assert op.birthday_notified_on is None, (
        "смена day/month должна сбросить guard, иначе cron не поздравит на новую дату"
    )


@pytest.mark.django_db
def test_changing_only_year_keeps_notified_guard(api_client, operator_user, op):
    """Меняем только год (тот же day/month) → guard сохраняется."""
    op.birth_date = dt.date(1990, 6, 15)
    op.birthday_notified_on = dt.date.today()
    op.save(update_fields=["birth_date", "birthday_notified_on"])

    api_client.force_authenticate(operator_user)
    r = api_client.patch(
        "/api/auth/me/", {"birth_date": "1985-06-15"}, format="json"
    )
    assert r.status_code == 200
    op.refresh_from_db()
    assert op.birth_date == dt.date(1985, 6, 15)
    assert op.birthday_notified_on == dt.date.today(), (
        "тот же day/month → guard не сбрасывается, иначе получим дубли за один день"
    )


@pytest.mark.django_db
def test_birthdays_today_endpoint(api_client, manager_user, op):
    op.birth_date = dt.date.today().replace(year=1990)
    op.save(update_fields=["birth_date"])

    api_client.force_authenticate(manager_user)
    r = api_client.get("/api/operators/birthdays-today/")
    assert r.status_code == 200, r.content
    rows = r.json()
    assert any(row["operator_id"] == op.id for row in rows)
    row = next(row for row in rows if row["operator_id"] == op.id)
    assert row["age"] == dt.date.today().year - 1990


@pytest.mark.django_db
def test_birthdays_today_endpoint_operator_forbidden(api_client, operator_user):
    api_client.force_authenticate(operator_user)
    r = api_client.get("/api/operators/birthdays-today/")
    assert r.status_code == 403

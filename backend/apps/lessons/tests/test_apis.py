import datetime as dt
import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from apps.operators.models import Operator
from apps.users.models import Profile, Role
from apps.lessons.models import DailyLesson

User = get_user_model()


@pytest.fixture
def api_client():
    return APIClient()


@pytest.fixture
def op1(db):
    return Operator.objects.create(full_name="Оп Один", status="active")


@pytest.fixture
def op2(db):
    return Operator.objects.create(full_name="Оп Два", status="active")


@pytest.fixture
def user1(db, op1):
    user = User.objects.create_user(username="op1", password="x")
    Profile.objects.create(user=user, role=Role.OPERATOR, operator=op1)
    return user


@pytest.fixture
def user2(db, op2):
    user = User.objects.create_user(username="op2", password="x")
    Profile.objects.create(user=user, role=Role.OPERATOR, operator=op2)
    return user


@pytest.fixture
def manager(db):
    user = User.objects.create_user(username="mgr", password="x")
    Profile.objects.create(user=user, role=Role.MANAGER)
    return user


@pytest.mark.django_db
def test_api_own_lesson(api_client, user1, op1, op2):
    today = timezone.localdate()
    yesterday = today - dt.timedelta(days=1)

    lesson1 = DailyLesson.objects.create(
        operator=op1,
        lesson_date=yesterday,
        summary="Твой вчерашний день",
        micro_lesson="Фокус",
        model_version="test",
        prompt_version="v1",
        stats_snapshot={},
    )

    api_client.force_authenticate(user1)

    # 0. Get today's lesson with peek=1 (should not mark as opened)
    r = api_client.get("/api/lessons/today/?peek=1")
    assert r.status_code == 200
    assert r.json()["opened_at"] is None
    lesson1.refresh_from_db()
    assert lesson1.opened_at is None

    # 1. Get today's lesson (which is yesterday's content)
    r = api_client.get("/api/lessons/today/")
    assert r.status_code == 200
    assert r.json()["summary"] == "Твой вчерашний день"
    assert r.json()["opened_at"] is not None

    # Verify database is updated
    lesson1.refresh_from_db()
    assert lesson1.opened_at is not None

    # 2. Get history
    r = api_client.get("/api/lessons/history/")
    assert r.status_code == 200
    assert len(r.json()) == 1
    assert r.json()[0]["summary"] == "Твой вчерашний день"

    # 3. Trying to access other operator's detail via general detail view
    # GET /api/lessons/?operator=op2&date=yesterday
    r = api_client.get(f"/api/lessons/?operator={op2.id}&date={yesterday}")
    assert r.status_code == 403


@pytest.fixture
def superadmin(db):
    user = User.objects.create_user(username="root", password="x")
    Profile.objects.create(user=user, role=Role.SUPERADMIN)
    return user


@pytest.mark.django_db
def test_operator_expands_own_lesson_detail_without_operator_param(
    api_client, user1, op1
):
    """Regression: operator on /lessons/history clicks a card -> UI calls
    GET /api/lessons/?date=... (no ?operator=), which used to 400 because
    the endpoint required both params. Backend now infers operator_id from
    the auth profile for non-manager roles.
    """
    yesterday = timezone.localdate() - dt.timedelta(days=1)
    DailyLesson.objects.create(
        operator=op1,
        lesson_date=yesterday,
        summary="Свой урок",
        micro_lesson="Фокус",
        model_version="test",
        prompt_version="v2",
    )
    api_client.force_authenticate(user1)

    r = api_client.get(f"/api/lessons/?date={yesterday}")
    assert r.status_code == 200
    assert r.json()["summary"] == "Свой урок"


@pytest.mark.django_db
def test_superadmin_can_read_history_and_detail(
    api_client, superadmin, op1
):
    """Regression: role checks used `role in (TEAM_LEAD, MANAGER)` and
    excluded SUPERADMIN. Product treats superadmin as senior, so history +
    detail must work with an ?operator= param.
    """
    yesterday = timezone.localdate() - dt.timedelta(days=1)
    DailyLesson.objects.create(
        operator=op1,
        lesson_date=yesterday,
        summary="Урок оператора для админа",
        micro_lesson="F",
        model_version="test",
        prompt_version="v2",
    )
    api_client.force_authenticate(superadmin)

    r = api_client.get(f"/api/lessons/history/?operator={op1.id}")
    assert r.status_code == 200
    assert len(r.json()) == 1

    r = api_client.get(f"/api/lessons/?operator={op1.id}&date={yesterday}")
    assert r.status_code == 200
    assert r.json()["summary"] == "Урок оператора для админа"


@pytest.mark.django_db
def test_api_manager_sees_all(api_client, manager, op1, op2):
    today = timezone.localdate()
    yesterday = today - dt.timedelta(days=1)

    DailyLesson.objects.create(
        operator=op1,
        lesson_date=yesterday,
        summary="Урок одного",
        micro_lesson="Фокус",
        model_version="test",
        prompt_version="v1",
    )

    api_client.force_authenticate(manager)

    # 1. Manager views history of op1
    r = api_client.get(f"/api/lessons/history/?operator={op1.id}")
    assert r.status_code == 200
    assert len(r.json()) == 1

    # 2. Manager views specific lesson detail of op1
    r = api_client.get(f"/api/lessons/?operator={op1.id}&date={yesterday}")
    assert r.status_code == 200
    assert r.json()["summary"] == "Урок одного"

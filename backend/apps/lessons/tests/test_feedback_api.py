import datetime as dt
import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from apps.lessons.models import DailyLesson, DailyLessonFeedback
from apps.operators.models import Operator
from apps.users.models import Profile, Role

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
    u = User.objects.create_user(username="op1", password="x")
    Profile.objects.create(user=u, role=Role.OPERATOR, operator=op1)
    return u


@pytest.fixture
def user2(db, op2):
    u = User.objects.create_user(username="op2", password="x")
    Profile.objects.create(user=u, role=Role.OPERATOR, operator=op2)
    return u


@pytest.fixture
def yesterday_lesson(db, op1):
    yesterday = timezone.localdate() - dt.timedelta(days=1)
    return DailyLesson.objects.create(
        operator=op1,
        lesson_date=yesterday,
        summary="s",
        micro_lesson="m",
        model_version="test",
        prompt_version="v2",
        stats_snapshot={},
    )


@pytest.mark.django_db
def test_feedback_helpful_created(api_client, user1, yesterday_lesson):
    api_client.force_authenticate(user1)
    r = api_client.post("/api/lessons/today/feedback/", {"rating": "helpful", "comment": "top"}, format="json")
    assert r.status_code == 200, r.content
    assert r.json()["rating"] == "helpful"
    assert r.json()["comment"] == "top"
    fb = DailyLessonFeedback.objects.get(lesson=yesterday_lesson)
    assert fb.rating == "helpful"
    assert fb.created_by == user1


@pytest.mark.django_db
def test_feedback_upsert_overwrites_previous(api_client, user1, yesterday_lesson):
    api_client.force_authenticate(user1)
    r1 = api_client.post("/api/lessons/today/feedback/", {"rating": "helpful"}, format="json")
    assert r1.status_code == 200
    r2 = api_client.post("/api/lessons/today/feedback/", {"rating": "not_helpful", "comment": "confusing"}, format="json")
    assert r2.status_code == 200
    assert DailyLessonFeedback.objects.filter(lesson=yesterday_lesson).count() == 1
    fb = DailyLessonFeedback.objects.get(lesson=yesterday_lesson)
    assert fb.rating == "not_helpful"
    assert fb.comment == "confusing"


@pytest.mark.django_db
def test_feedback_invalid_rating_rejected(api_client, user1, yesterday_lesson):
    api_client.force_authenticate(user1)
    r = api_client.post("/api/lessons/today/feedback/", {"rating": "meh"}, format="json")
    assert r.status_code == 400


@pytest.mark.django_db
def test_feedback_no_lesson_yields_404(api_client, user2):
    api_client.force_authenticate(user2)
    r = api_client.post("/api/lessons/today/feedback/", {"rating": "helpful"}, format="json")
    assert r.status_code == 404


@pytest.mark.django_db
def test_lesson_serializer_includes_feedback(api_client, user1, yesterday_lesson):
    api_client.force_authenticate(user1)
    api_client.post("/api/lessons/today/feedback/", {"rating": "helpful"}, format="json")
    r = api_client.get("/api/lessons/today/?peek=1")
    assert r.status_code == 200
    data = r.json()
    assert data["feedback"] is not None
    assert data["feedback"]["rating"] == "helpful"

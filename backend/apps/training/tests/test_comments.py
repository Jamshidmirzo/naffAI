import pytest

from apps.training.models import TrainingComment, TrainingLesson


@pytest.fixture
def lesson(db):
    return TrainingLesson.objects.create(title="L", video_url="https://x.example/v")


@pytest.mark.django_db
def test_operator_adds_comment(api_client, user1, op1, lesson):
    api_client.force_authenticate(user1)
    r = api_client.post(
        f"/api/training/my-lessons/{lesson.id}/comments/",
        {"text": "Полезно, спасибо!"},
        format="json",
    )
    assert r.status_code == 201, r.content
    assert r.json()["text"] == "Полезно, спасибо!"
    assert TrainingComment.objects.count() == 1
    c = TrainingComment.objects.get()
    assert c.operator == op1
    assert c.lesson == lesson


@pytest.mark.django_db
def test_comment_empty_rejected(api_client, user1, lesson):
    api_client.force_authenticate(user1)
    r = api_client.post(
        f"/api/training/my-lessons/{lesson.id}/comments/",
        {"text": "   "},
        format="json",
    )
    assert r.status_code == 400


@pytest.mark.django_db
def test_comment_list_visible_to_operators_and_manager(
    api_client, user1, user2, manager, lesson
):
    api_client.force_authenticate(user1)
    api_client.post(
        f"/api/training/my-lessons/{lesson.id}/comments/",
        {"text": "from op1"},
        format="json",
    )
    api_client.force_authenticate(user2)
    api_client.post(
        f"/api/training/my-lessons/{lesson.id}/comments/",
        {"text": "from op2"},
        format="json",
    )
    # Читают все
    for user in [user1, user2, manager]:
        api_client.force_authenticate(user)
        r = api_client.get(f"/api/training/my-lessons/{lesson.id}/comments/")
        assert r.status_code == 200, (user.username, r.content)
        texts = {row["text"] for row in r.json()}
        assert {"from op1", "from op2"} == texts


@pytest.mark.django_db
def test_comment_on_inactive_lesson_rejected(api_client, user1, lesson):
    lesson.is_active = False
    lesson.save(update_fields=["is_active"])
    api_client.force_authenticate(user1)
    r = api_client.post(
        f"/api/training/my-lessons/{lesson.id}/comments/",
        {"text": "hi"},
        format="json",
    )
    assert r.status_code == 400

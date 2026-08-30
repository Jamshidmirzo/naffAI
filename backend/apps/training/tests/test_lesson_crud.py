import json

import pytest

from apps.training.models import TrainingLesson


@pytest.mark.django_db
def test_manager_creates_lesson_with_video_only(api_client, manager):
    api_client.force_authenticate(manager)
    r = api_client.post(
        "/api/training/lessons/",
        {
            "title": "Основы продаж",
            "description": "Как открыть звонок",
            "video_url": "https://www.youtube.com/watch?v=abc",
        },
        format="json",
    )
    assert r.status_code == 201, r.content
    data = r.json()
    assert data["title"] == "Основы продаж"
    assert data["video_url"] == "https://www.youtube.com/watch?v=abc"
    assert data["is_active"] is True
    assert TrainingLesson.objects.count() == 1


@pytest.mark.django_db
def test_operator_cannot_create_or_edit_lesson(api_client, user1):
    api_client.force_authenticate(user1)
    r = api_client.post(
        "/api/training/lessons/",
        {"title": "hack", "video_url": "https://x.example/vid"},
        format="json",
    )
    assert r.status_code == 403

    lesson = TrainingLesson.objects.create(
        title="Ex", video_url="https://x.example/vid"
    )
    r = api_client.patch(
        f"/api/training/lessons/{lesson.id}/",
        {"title": "changed"},
        format="json",
    )
    assert r.status_code == 403
    r = api_client.delete(f"/api/training/lessons/{lesson.id}/")
    assert r.status_code == 403


@pytest.mark.django_db
def test_manager_creates_lesson_with_test(api_client, manager):
    api_client.force_authenticate(manager)
    payload = {
        "title": "Тест по возражениям",
        "video_url": "https://x.example/v",
        "questions": [
            {
                "text": "Что делать при 'дорого'?",
                "answers": [
                    {"text": "Соглашусь", "is_correct": False},
                    {"text": "Уточню бюджет", "is_correct": True},
                    {"text": "Прекращу разговор", "is_correct": False},
                ],
            },
            {
                "text": "Первый шаг после приветствия?",
                "answers": [
                    {"text": "Продать сразу", "is_correct": False},
                    {"text": "Задать вопрос", "is_correct": True},
                ],
            },
        ],
    }
    r = api_client.post(
        "/api/training/lessons/",
        # multipart: questions идёт как JSON-строка (реалистично для UI)
        {"title": payload["title"], "video_url": payload["video_url"],
         "questions": json.dumps(payload["questions"])},
        format="multipart",
    )
    assert r.status_code == 201, r.content
    body = r.json()
    assert len(body["questions"]) == 2
    assert body["questions"][0]["answers"][1]["is_correct"] is True
    assert body["questions"][1]["text"] == "Первый шаг после приветствия?"


@pytest.mark.django_db
def test_manager_soft_deletes_lesson(api_client, manager):
    api_client.force_authenticate(manager)
    lesson = TrainingLesson.objects.create(
        title="X", video_url="https://x.example/v"
    )
    r = api_client.delete(f"/api/training/lessons/{lesson.id}/")
    assert r.status_code == 204
    lesson.refresh_from_db()
    assert lesson.is_active is False
    # Всё ещё виден менеджеру в списке (soft-delete):
    r = api_client.get("/api/training/lessons/")
    assert r.status_code == 200
    ids = {row["id"] for row in r.json()}
    assert lesson.id in ids


@pytest.mark.django_db
def test_operator_sees_only_active_lessons(api_client, user1, manager):
    api_client.force_authenticate(manager)
    live = TrainingLesson.objects.create(
        title="Live", video_url="https://x.example/v"
    )
    hidden = TrainingLesson.objects.create(
        title="Hidden", video_url="https://x.example/h", is_active=False
    )
    api_client.force_authenticate(user1)
    r = api_client.get("/api/training/my-lessons/")
    assert r.status_code == 200
    ids = {row["id"] for row in r.json()}
    assert live.id in ids
    assert hidden.id not in ids


@pytest.mark.django_db
def test_manager_updates_lesson_and_replaces_test(api_client, manager):
    api_client.force_authenticate(manager)
    r = api_client.post(
        "/api/training/lessons/",
        {
            "title": "v1",
            "video_url": "https://x.example/v",
            "questions": json.dumps(
                [
                    {
                        "text": "Q1",
                        "answers": [
                            {"text": "a", "is_correct": True},
                            {"text": "b", "is_correct": False},
                        ],
                    }
                ]
            ),
        },
        format="multipart",
    )
    assert r.status_code == 201
    lesson_id = r.json()["id"]

    r = api_client.patch(
        f"/api/training/lessons/{lesson_id}/",
        {
            "title": "v2",
            "questions": json.dumps(
                [
                    {
                        "text": "Q1-new",
                        "answers": [
                            {"text": "x", "is_correct": True},
                            {"text": "y", "is_correct": False},
                            {"text": "z", "is_correct": False},
                        ],
                    },
                    {
                        "text": "Q2-new",
                        "answers": [
                            {"text": "p", "is_correct": False},
                            {"text": "q", "is_correct": True},
                        ],
                    },
                ]
            ),
        },
        format="multipart",
    )
    assert r.status_code == 200, r.content
    body = r.json()
    assert body["title"] == "v2"
    assert len(body["questions"]) == 2
    assert body["questions"][0]["text"] == "Q1-new"
    assert len(body["questions"][0]["answers"]) == 3

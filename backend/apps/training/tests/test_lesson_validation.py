import json

import pytest


@pytest.mark.django_db
def test_lesson_rejects_when_no_video_and_no_file(api_client, manager):
    api_client.force_authenticate(manager)
    r = api_client.post(
        "/api/training/lessons/",
        {"title": "Only title"},
        format="json",
    )
    assert r.status_code == 400
    body = r.json()
    assert "video_url" in body or "detail" in body


@pytest.mark.django_db
def test_lesson_rejects_empty_title(api_client, manager):
    api_client.force_authenticate(manager)
    r = api_client.post(
        "/api/training/lessons/",
        {"title": "   ", "video_url": "https://x.example/v"},
        format="json",
    )
    assert r.status_code == 400
    assert "title" in r.json()


@pytest.mark.django_db
def test_test_requires_at_least_two_answers(api_client, manager):
    api_client.force_authenticate(manager)
    r = api_client.post(
        "/api/training/lessons/",
        {
            "title": "T",
            "video_url": "https://x.example/v",
            "questions": json.dumps(
                [
                    {
                        "text": "Q",
                        "answers": [{"text": "only one", "is_correct": True}],
                    }
                ]
            ),
        },
        format="multipart",
    )
    assert r.status_code == 400
    assert "questions" in r.json()


@pytest.mark.django_db
def test_test_requires_exactly_one_correct_answer(api_client, manager):
    api_client.force_authenticate(manager)

    # Zero correct answers
    r = api_client.post(
        "/api/training/lessons/",
        {
            "title": "T",
            "video_url": "https://x.example/v",
            "questions": json.dumps(
                [
                    {
                        "text": "Q",
                        "answers": [
                            {"text": "a", "is_correct": False},
                            {"text": "b", "is_correct": False},
                        ],
                    }
                ]
            ),
        },
        format="multipart",
    )
    assert r.status_code == 400
    assert "questions" in r.json()

    # Two correct answers
    r = api_client.post(
        "/api/training/lessons/",
        {
            "title": "T2",
            "video_url": "https://x.example/v",
            "questions": json.dumps(
                [
                    {
                        "text": "Q",
                        "answers": [
                            {"text": "a", "is_correct": True},
                            {"text": "b", "is_correct": True},
                        ],
                    }
                ]
            ),
        },
        format="multipart",
    )
    assert r.status_code == 400


@pytest.mark.django_db
def test_test_requires_non_empty_question_text(api_client, manager):
    api_client.force_authenticate(manager)
    r = api_client.post(
        "/api/training/lessons/",
        {
            "title": "T",
            "video_url": "https://x.example/v",
            "questions": json.dumps(
                [
                    {
                        "text": "   ",
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
    assert r.status_code == 400

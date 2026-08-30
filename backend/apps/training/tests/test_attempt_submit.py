import pytest

from apps.training.models import (
    TrainingAnswer,
    TrainingAttempt,
    TrainingLesson,
    TrainingQuestion,
)


def _build_lesson_with_test() -> TrainingLesson:
    lesson = TrainingLesson.objects.create(
        title="Тест", video_url="https://x.example/v"
    )
    q1 = TrainingQuestion.objects.create(lesson=lesson, text="Q1", order=0)
    q1_a1 = TrainingAnswer.objects.create(question=q1, text="wrong", is_correct=False, order=0)
    q1_a2 = TrainingAnswer.objects.create(question=q1, text="right", is_correct=True, order=1)

    q2 = TrainingQuestion.objects.create(lesson=lesson, text="Q2", order=1)
    q2_a1 = TrainingAnswer.objects.create(question=q2, text="right", is_correct=True, order=0)
    q2_a2 = TrainingAnswer.objects.create(question=q2, text="wrong", is_correct=False, order=1)
    return lesson, (q1, q1_a1, q1_a2), (q2, q2_a1, q2_a2)


@pytest.mark.django_db
def test_operator_detail_hides_is_correct(api_client, user1):
    lesson, _, _ = _build_lesson_with_test()
    api_client.force_authenticate(user1)
    r = api_client.get(f"/api/training/my-lessons/{lesson.id}/")
    assert r.status_code == 200
    body = r.json()
    assert len(body["questions"]) == 2
    for q in body["questions"]:
        for a in q["answers"]:
            assert "is_correct" not in a, "operator должен НЕ видеть правильный ответ до submit"


@pytest.mark.django_db
def test_attempt_scoring_all_correct(api_client, user1):
    lesson, (q1, _, q1_right), (q2, q2_right, _) = _build_lesson_with_test()
    api_client.force_authenticate(user1)
    r = api_client.post(
        f"/api/training/my-lessons/{lesson.id}/submit/",
        {"choices": {str(q1.id): q1_right.id, str(q2.id): q2_right.id}},
        format="json",
    )
    assert r.status_code == 200, r.content
    body = r.json()
    assert body["score_pct"] == 100
    assert all(pq["correct"] for pq in body["per_question"])
    assert TrainingAttempt.objects.filter(lesson=lesson, operator=user1.profile.operator).count() == 1


@pytest.mark.django_db
def test_attempt_scoring_partial(api_client, user1):
    lesson, (q1, _, q1_right), (q2, _, q2_wrong) = _build_lesson_with_test()
    api_client.force_authenticate(user1)
    r = api_client.post(
        f"/api/training/my-lessons/{lesson.id}/submit/",
        {"choices": {str(q1.id): q1_right.id, str(q2.id): q2_wrong.id}},
        format="json",
    )
    assert r.status_code == 200
    body = r.json()
    assert body["score_pct"] == 50
    per_q = {pq["question_id"]: pq for pq in body["per_question"]}
    assert per_q[q1.id]["correct"] is True
    assert per_q[q2.id]["correct"] is False


@pytest.mark.django_db
def test_attempt_missing_question_counts_wrong(api_client, user1):
    """Skipped question — считается неправильным, chosen_answer=None."""
    lesson, (q1, _, q1_right), (q2, _, _) = _build_lesson_with_test()
    api_client.force_authenticate(user1)
    r = api_client.post(
        f"/api/training/my-lessons/{lesson.id}/submit/",
        {"choices": {str(q1.id): q1_right.id}},  # q2 пропущен
        format="json",
    )
    assert r.status_code == 200
    body = r.json()
    assert body["score_pct"] == 50


@pytest.mark.django_db
def test_second_attempt_blocked(api_client, user1):
    lesson, (q1, _, q1_right), (q2, q2_right, _) = _build_lesson_with_test()
    api_client.force_authenticate(user1)
    r1 = api_client.post(
        f"/api/training/my-lessons/{lesson.id}/submit/",
        {"choices": {str(q1.id): q1_right.id, str(q2.id): q2_right.id}},
        format="json",
    )
    assert r1.status_code == 200
    r2 = api_client.post(
        f"/api/training/my-lessons/{lesson.id}/submit/",
        {"choices": {str(q1.id): q1_right.id, str(q2.id): q2_right.id}},
        format="json",
    )
    assert r2.status_code == 400


@pytest.mark.django_db
def test_operator_detail_after_submit_shows_result(api_client, user1):
    lesson, (q1, q1_wrong, q1_right), (q2, q2_right, _) = _build_lesson_with_test()
    api_client.force_authenticate(user1)
    api_client.post(
        f"/api/training/my-lessons/{lesson.id}/submit/",
        {"choices": {str(q1.id): q1_wrong.id, str(q2.id): q2_right.id}},
        format="json",
    )
    r = api_client.get(f"/api/training/my-lessons/{lesson.id}/")
    body = r.json()
    assert body["attempt"] is not None
    assert body["attempt"]["score_pct"] == 50
    per_q = {c["question_id"]: c for c in body["attempt"]["per_question"]}
    assert per_q[q1.id]["is_correct"] is False
    assert per_q[q1.id]["chosen_answer_id"] == q1_wrong.id
    assert per_q[q2.id]["is_correct"] is True


@pytest.mark.django_db
def test_submit_rejects_answer_from_other_question(api_client, user1):
    lesson, (q1, _, q1_right), (q2, q2_right, _) = _build_lesson_with_test()
    api_client.force_authenticate(user1)
    # q1 → answer из q2 → должна быть 400
    r = api_client.post(
        f"/api/training/my-lessons/{lesson.id}/submit/",
        {"choices": {str(q1.id): q2_right.id, str(q2.id): q2_right.id}},
        format="json",
    )
    assert r.status_code == 400


@pytest.mark.django_db
def test_submit_without_operator_link_400(api_client, manager):
    # manager без operator_id — permission пропускает (senior),
    # но attempt требует operator: должен быть 400.
    lesson, (q1, _, q1_right), (q2, q2_right, _) = _build_lesson_with_test()
    api_client.force_authenticate(manager)
    r = api_client.post(
        f"/api/training/my-lessons/{lesson.id}/submit/",
        {"choices": {str(q1.id): q1_right.id, str(q2.id): q2_right.id}},
        format="json",
    )
    assert r.status_code == 400

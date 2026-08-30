import pytest

from apps.training.models import (
    TrainingAnswer,
    TrainingAttempt,
    TrainingAnswerChoice,
    TrainingLesson,
    TrainingQuestion,
)
from django.utils import timezone


def _lesson_with_q():
    lesson = TrainingLesson.objects.create(title="s", video_url="https://x.example/v")
    q = TrainingQuestion.objects.create(lesson=lesson, text="Q")
    a_wrong = TrainingAnswer.objects.create(question=q, text="w", is_correct=False)
    a_right = TrainingAnswer.objects.create(question=q, text="r", is_correct=True)
    return lesson, q, a_wrong, a_right


def _completed_attempt(lesson, operator, choices_by_qid, is_correct_map):
    """
    Быстро формируем завершённый attempt с заданной комбинацией
    правильности ответов, минуя submit-service — тесту нужен только
    итог для селектора статистики.
    """
    attempt = TrainingAttempt.objects.create(
        lesson=lesson,
        operator=operator,
        completed_at=timezone.now(),
        score_pct=(sum(1 for v in is_correct_map.values() if v) * 100) // len(is_correct_map),
    )
    for qid, aid in choices_by_qid.items():
        TrainingAnswerChoice.objects.create(
            attempt=attempt,
            question_id=qid,
            chosen_answer_id=aid,
            is_correct=is_correct_map[qid],
        )
    return attempt


@pytest.mark.django_db
def test_stats_empty_lesson_returns_shell(api_client, manager):
    api_client.force_authenticate(manager)
    lesson = TrainingLesson.objects.create(
        title="Nobody attempted", video_url="https://x.example/v"
    )
    r = api_client.get(f"/api/training/lessons/{lesson.id}/stats/")
    assert r.status_code == 200
    body = r.json()
    assert body["attempts_count"] == 0
    assert body["avg_score"] is None
    assert body["questions"] == []


@pytest.mark.django_db
def test_stats_error_pct_and_wrong_ops(api_client, manager, op1, op2):
    lesson, q, a_wrong, a_right = _lesson_with_q()
    _completed_attempt(lesson, op1, {q.id: a_wrong.id}, {q.id: False})
    _completed_attempt(lesson, op2, {q.id: a_right.id}, {q.id: True})

    api_client.force_authenticate(manager)
    r = api_client.get(f"/api/training/lessons/{lesson.id}/stats/")
    assert r.status_code == 200
    body = r.json()
    assert body["attempts_count"] == 2
    assert body["avg_score"] == 50.0
    assert len(body["questions"]) == 1
    q_stat = body["questions"][0]
    assert q_stat["error_pct"] == 50.0
    assert q_stat["wrong"] == 1
    assert q_stat["correct"] == 1
    names = {w["full_name"] for w in q_stat["wrong_operators"]}
    assert op1.full_name in names
    assert op2.full_name not in names


@pytest.mark.django_db
def test_stats_only_counts_completed_attempts(api_client, manager, op1):
    lesson, q, a_wrong, a_right = _lesson_with_q()
    # Незавершённый (черновик) attempt: completed_at=None → не входит в stat.
    draft = TrainingAttempt.objects.create(lesson=lesson, operator=op1)
    TrainingAnswerChoice.objects.create(
        attempt=draft, question=q, chosen_answer=a_wrong, is_correct=False
    )
    api_client.force_authenticate(manager)
    r = api_client.get(f"/api/training/lessons/{lesson.id}/stats/")
    body = r.json()
    assert body["attempts_count"] == 0
    assert body["questions"][0]["attempts"] == 0


@pytest.mark.django_db
def test_operator_cannot_read_stats(api_client, user1):
    lesson, _, _, _ = _lesson_with_q()
    api_client.force_authenticate(user1)
    r = api_client.get(f"/api/training/lessons/{lesson.id}/stats/")
    assert r.status_code == 403

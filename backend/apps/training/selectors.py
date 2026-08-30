"""
Read-side queries for the ``training`` app.

Ничего мутирующего. Всё, что возвращает данные — здесь.
"""

from __future__ import annotations

from django.db.models import Count, Prefetch, Q, QuerySet
from django.db.models.functions import Cast
from django.db import models

from apps.operators.models import Operator

from .models import (
    TrainingAnswer,
    TrainingAnswerChoice,
    TrainingAttempt,
    TrainingComment,
    TrainingLesson,
    TrainingQuestion,
)


def _lesson_qs_with_related() -> QuerySet[TrainingLesson]:
    """
    Базовый queryset с prefetch'ом вопросов+ответов для detail-view.
    Возвращает уроки в нужном порядке (order, id).
    """
    answers_qs = TrainingAnswer.objects.order_by("order", "id")
    questions_qs = TrainingQuestion.objects.order_by("order", "id").prefetch_related(
        Prefetch("answers", queryset=answers_qs)
    )
    return TrainingLesson.objects.prefetch_related(
        Prefetch("questions", queryset=questions_qs)
    )


def lessons_for_manager() -> QuerySet[TrainingLesson]:
    """Все уроки (active + inactive) с counts аттемптов/комментариев."""
    return (
        TrainingLesson.objects.all()
        .annotate(
            attempts_count=Count("attempts", distinct=True),
            comments_count=Count("comments", distinct=True),
            questions_count=Count("questions", distinct=True),
        )
        .order_by("-created_at")
    )


def lessons_for_operator(operator: Operator) -> QuerySet[TrainingLesson]:
    """
    Только активные уроки, с prefetch'ом ключевых полей. attempt-статус
    считаем во view/serializer через отдельный lookup (проще, чем плодить
    subquery).
    """
    return (
        _lesson_qs_with_related()
        .filter(is_active=True)
        .annotate(
            questions_count=Count("questions", distinct=True),
            comments_count=Count("comments", distinct=True),
        )
        .order_by("-created_at")
    )


def lesson_get(lesson_id: int, *, include_inactive: bool = False) -> TrainingLesson | None:
    qs = _lesson_qs_with_related()
    if not include_inactive:
        qs = qs.filter(is_active=True)
    return qs.filter(pk=lesson_id).first()


def attempt_for(operator: Operator, lesson_id: int) -> TrainingAttempt | None:
    return TrainingAttempt.objects.filter(
        operator=operator, lesson_id=lesson_id
    ).prefetch_related("choices").first()


def lesson_stats(lesson_id: int) -> dict:
    """
    Per-question статистика ошибок + список ошибающихся операторов.

    Возвращает:
    {
      "lesson_id": int,
      "attempts_count": int,
      "avg_score": float | None,
      "questions": [
        {
          "id": int,
          "text": str,
          "order": int,
          "attempts": int,
          "correct": int,
          "wrong": int,
          "error_pct": float,
          "wrong_operators": [{"id": int, "full_name": str}, ...],
        },
        ...
      ],
    }
    """
    lesson = TrainingLesson.objects.filter(pk=lesson_id).first()
    if lesson is None:
        return {
            "lesson_id": lesson_id,
            "attempts_count": 0,
            "avg_score": None,
            "questions": [],
        }

    completed = TrainingAttempt.objects.filter(
        lesson_id=lesson_id, completed_at__isnull=False
    )
    attempts_count = completed.count()
    avg_score = (
        completed.aggregate(
            avg=models.Avg(Cast("score_pct", output_field=models.FloatField()))
        )["avg"]
        if attempts_count
        else None
    )

    questions = TrainingQuestion.objects.filter(lesson_id=lesson_id).order_by(
        "order", "id"
    )

    # Все choices (только для завершённых аттемптов) одним запросом,
    # чтобы не делать N+1 по вопросам.
    choice_rows = TrainingAnswerChoice.objects.filter(
        attempt__lesson_id=lesson_id,
        attempt__completed_at__isnull=False,
    ).values("question_id", "is_correct", "attempt__operator_id")

    stats_by_q: dict[int, dict] = {}
    wrong_ops_by_q: dict[int, set[int]] = {}
    for row in choice_rows:
        qid = row["question_id"]
        d = stats_by_q.setdefault(qid, {"attempts": 0, "correct": 0, "wrong": 0})
        d["attempts"] += 1
        if row["is_correct"]:
            d["correct"] += 1
        else:
            d["wrong"] += 1
            wrong_ops_by_q.setdefault(qid, set()).add(row["attempt__operator_id"])

    all_wrong_ids = {op_id for ids in wrong_ops_by_q.values() for op_id in ids}
    op_name_by_id = {
        op.id: op.full_name for op in Operator.objects.filter(pk__in=all_wrong_ids)
    }

    q_out = []
    for q in questions:
        s = stats_by_q.get(q.id, {"attempts": 0, "correct": 0, "wrong": 0})
        total = s["attempts"]
        error_pct = round(s["wrong"] / total * 100, 1) if total else 0.0
        wrong_ids = sorted(wrong_ops_by_q.get(q.id, set()))
        q_out.append(
            {
                "id": q.id,
                "text": q.text,
                "order": q.order,
                "attempts": total,
                "correct": s["correct"],
                "wrong": s["wrong"],
                "error_pct": error_pct,
                "wrong_operators": [
                    {"id": op_id, "full_name": op_name_by_id.get(op_id, f"#{op_id}")}
                    for op_id in wrong_ids
                ],
            }
        )

    return {
        "lesson_id": lesson.id,
        "attempts_count": attempts_count,
        "avg_score": round(avg_score, 1) if avg_score is not None else None,
        "questions": q_out,
    }


def comments_for_lesson(lesson_id: int) -> QuerySet[TrainingComment]:
    """Комментарии к уроку в порядке от новых к старым."""
    return TrainingComment.objects.filter(lesson_id=lesson_id).select_related(
        "operator"
    )


def operator_attempts_map(operator: Operator) -> dict[int, dict]:
    """
    Быстрая карта {lesson_id: {completed_at, score_pct}} для оператора —
    используется в list-view, чтобы отдать progress-badge без N+1.
    Только завершённые попытки (незавершённые ещё не имеют score_pct).
    """
    rows = TrainingAttempt.objects.filter(
        operator=operator, completed_at__isnull=False
    ).values("lesson_id", "completed_at", "score_pct")
    return {
        r["lesson_id"]: {
            "completed_at": r["completed_at"],
            "score_pct": r["score_pct"],
        }
        for r in rows
    }

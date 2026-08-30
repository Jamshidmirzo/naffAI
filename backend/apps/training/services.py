"""
Write-side business logic for the ``training`` app.

Все мутации — здесь. Views/serializers остаются тонкими. Валидация,
которая шире одного поля (например «минимум одно из video_url/file»,
«ровно один правильный ответ в вопросе») живёт в services, не в
Model.clean() и не в serializer.validate().
"""

from __future__ import annotations

from typing import Any, Iterable

from django.core.exceptions import ValidationError as DjangoValidationError
from django.db import transaction
from django.utils import timezone

from apps.operators.models import Operator

from .models import (
    TrainingAnswer,
    TrainingAnswerChoice,
    TrainingAttempt,
    TrainingComment,
    TrainingLesson,
    TrainingQuestion,
)


class TrainingValidationError(Exception):
    """
    Кидается сервисом при бизнес-валидации. Ловится вьюхой и превращается
    в 400. Отдельный тип, чтобы отличать от Django-ValidationError (та
    прилетает из Model.clean() и уже сама превращается в 400 DRF-ом).
    """

    def __init__(self, message: str, *, field: str | None = None):
        super().__init__(message)
        self.message = message
        self.field = field

    def as_dict(self) -> dict[str, Any]:
        if self.field:
            return {self.field: [self.message]}
        return {"detail": self.message}


# ---------- helpers ----------


def _validate_questions_shape(questions: Iterable[dict]) -> list[dict]:
    """
    Проверяет минимальные требования к структуре теста:
    - каждый вопрос имеет non-empty `text`,
    - у каждого вопроса минимум 2 ответа,
    - ровно один ответ помечен `is_correct=True`.

    Возвращает нормализованный список вопросов (списком, чтобы дважды
    не итерировать генератор).
    """
    result: list[dict] = []
    for idx, q in enumerate(questions):
        text = str(q.get("text", "") or "").strip()
        if not text:
            raise TrainingValidationError(
                f"Вопрос №{idx + 1}: текст не может быть пустым.",
                field="questions",
            )
        answers = list(q.get("answers", []) or [])
        if len(answers) < 2:
            raise TrainingValidationError(
                f"Вопрос №{idx + 1}: нужно минимум 2 варианта ответа.",
                field="questions",
            )
        correct_count = sum(1 for a in answers if bool(a.get("is_correct")))
        if correct_count != 1:
            raise TrainingValidationError(
                f"Вопрос №{idx + 1}: ровно один ответ должен быть правильным.",
                field="questions",
            )
        # Нормализуем ответы: убираем ведущие/висячие пробелы
        norm_answers: list[dict] = []
        for a_idx, a in enumerate(answers):
            a_text = str(a.get("text", "") or "").strip()
            if not a_text:
                raise TrainingValidationError(
                    f"Вопрос №{idx + 1}, ответ №{a_idx + 1}: текст не может быть пустым.",
                    field="questions",
                )
            norm_answers.append(
                {
                    "text": a_text,
                    "is_correct": bool(a.get("is_correct")),
                    "order": int(a.get("order", a_idx) or 0),
                }
            )
        result.append(
            {
                "text": text,
                "order": int(q.get("order", idx) or 0),
                "answers": norm_answers,
            }
        )
    return result


def _create_questions_bulk(lesson: TrainingLesson, questions: list[dict]) -> None:
    """Массово создаёт вопросы + ответы для урока. `questions` уже валидирован."""
    for q in questions:
        question = TrainingQuestion.objects.create(
            lesson=lesson, text=q["text"], order=q["order"]
        )
        TrainingAnswer.objects.bulk_create(
            [
                TrainingAnswer(
                    question=question,
                    text=a["text"],
                    is_correct=a["is_correct"],
                    order=a["order"],
                )
                for a in q["answers"]
            ]
        )


# ---------- lesson CRUD ----------


@transaction.atomic
def lesson_create(
    *,
    title: str,
    description: str = "",
    video_url: str = "",
    file: Any = None,
    is_active: bool = True,
    questions: Iterable[dict] | None = None,
    created_by=None,
) -> TrainingLesson:
    """
    Создать урок + опциональный тест. Атомарно, чтобы у нас не появилось
    lesson без questions (или наполовину созданного теста) при сбое.
    """
    title = (title or "").strip()
    if not title:
        raise TrainingValidationError("Название не может быть пустым.", field="title")

    validated_questions = (
        _validate_questions_shape(questions or []) if questions else []
    )

    lesson = TrainingLesson(
        title=title,
        description=(description or "").strip(),
        video_url=(video_url or "").strip(),
        file=file,
        is_active=bool(is_active),
        created_by=created_by if getattr(created_by, "is_authenticated", False) else None,
    )
    # Явно вызываем clean() — иначе бизнес-правило «нужно медиа»
    # проскочит, т.к. `full_clean()` DRF в services не делает.
    try:
        lesson.clean()
    except DjangoValidationError as e:
        # Пробрасываем как наш TrainingValidationError — вьюха ждёт именно его.
        err = e.message_dict if hasattr(e, "message_dict") else {"detail": e.messages}
        # Достаём первое поле/сообщение, чтобы вернуть внятный текст.
        if isinstance(err, dict) and err:
            field = next(iter(err))
            msg = err[field][0] if isinstance(err[field], list) else str(err[field])
            raise TrainingValidationError(msg, field=field)
        raise TrainingValidationError(str(e))

    lesson.save()

    if validated_questions:
        _create_questions_bulk(lesson, validated_questions)

    return lesson


@transaction.atomic
def lesson_update(
    lesson_id: int,
    *,
    title: str | None = None,
    description: str | None = None,
    video_url: str | None = None,
    file: Any = ...,  # sentinel — «не трогать»; None = очистить
    is_active: bool | None = None,
    questions: Iterable[dict] | None = None,
    clear_file: bool = False,
) -> TrainingLesson:
    """
    Обновление урока. Если `questions` передан — старые вопросы (и их
    ответы) удаляются каскадом; TrainingAttempt/AnswerChoice сохраняются
    (chosen_answer → SET_NULL), но перестают ссылаться на актуальные
    ответы. Это ок, статистика denorm-хранится в `is_correct` на choice.
    """
    lesson = TrainingLesson.objects.select_for_update().filter(pk=lesson_id).first()
    if lesson is None:
        raise TrainingValidationError("Урок не найден.", field="detail")

    if title is not None:
        title = title.strip()
        if not title:
            raise TrainingValidationError("Название не может быть пустым.", field="title")
        lesson.title = title
    if description is not None:
        lesson.description = description.strip()
    if video_url is not None:
        lesson.video_url = video_url.strip()
    if clear_file:
        lesson.file = None
    elif file is not ...:
        lesson.file = file
    if is_active is not None:
        lesson.is_active = bool(is_active)

    # Валидация медиа — video ИЛИ file обязательны и после обновления.
    try:
        lesson.clean()
    except DjangoValidationError as e:
        err = e.message_dict if hasattr(e, "message_dict") else {"detail": e.messages}
        if isinstance(err, dict) and err:
            field = next(iter(err))
            msg = err[field][0] if isinstance(err[field], list) else str(err[field])
            raise TrainingValidationError(msg, field=field)
        raise TrainingValidationError(str(e))

    lesson.save()

    if questions is not None:
        validated = _validate_questions_shape(questions)
        # Полная замена теста: сносим старые вопросы каскадом (унесёт
        # answers + связанные с ними choices). Аттемпты (attempts) при этом
        # сохраняются — score_pct у них остаётся зафиксированным. Такое
        # поведение осознанное: если менеджер полностью переписал тест,
        # старая per-question статистика становится нерелевантной, а вот
        # факт «оператор проходил урок и получил такой-то итог» — важен.
        TrainingQuestion.objects.filter(lesson=lesson).delete()
        _create_questions_bulk(lesson, validated)

    lesson.refresh_from_db()
    return lesson


@transaction.atomic
def lesson_soft_delete(lesson_id: int) -> TrainingLesson:
    """Soft-delete: is_active=False. Attempts/comments сохраняются."""
    lesson = TrainingLesson.objects.filter(pk=lesson_id).first()
    if lesson is None:
        raise TrainingValidationError("Урок не найден.", field="detail")
    lesson.is_active = False
    lesson.save(update_fields=["is_active", "updated_at"])
    return lesson


# ---------- attempt / comment ----------


@transaction.atomic
def attempt_submit(
    *,
    operator: Operator,
    lesson_id: int,
    choices: dict[int, int],
) -> tuple[TrainingAttempt, list[dict]]:
    """
    Проходит тест. Идемпотентно НЕ является: повторный submit → 400.

    `choices` = {question_id: answer_id}. Если пропущен вопрос — он
    засчитывается как неправильный (chosen_answer=None, is_correct=False).

    Возвращает `(attempt, per_question_result)`. `per_question_result` —
    список dict'ов для UI: `{q_id, correct: bool, correct_answer_id: int}`.
    """
    lesson = TrainingLesson.objects.filter(pk=lesson_id, is_active=True).first()
    if lesson is None:
        raise TrainingValidationError("Урок не найден или неактивен.", field="detail")

    existing = TrainingAttempt.objects.filter(
        lesson=lesson, operator=operator
    ).first()
    if existing and existing.completed_at is not None:
        raise TrainingValidationError(
            "Вы уже прошли этот тест.", field="detail"
        )

    questions = list(
        TrainingQuestion.objects.filter(lesson=lesson).order_by("order", "id")
    )
    if not questions:
        raise TrainingValidationError(
            "У этого урока нет теста.", field="detail"
        )

    # Достаём все ответы одной пачкой, чтобы валидировать (a_id принадлежит q_id).
    answer_rows = list(
        TrainingAnswer.objects.filter(question__lesson=lesson).values(
            "id", "question_id", "is_correct"
        )
    )
    answers_by_id: dict[int, dict] = {r["id"]: r for r in answer_rows}
    correct_answer_by_q: dict[int, int] = {}
    for r in answer_rows:
        if r["is_correct"]:
            correct_answer_by_q.setdefault(r["question_id"], r["id"])

    attempt = existing or TrainingAttempt.objects.create(
        lesson=lesson, operator=operator
    )

    correct_count = 0
    per_question: list[dict] = []
    # Пере-создаём choices при повторе (existing без completed_at — старый черновик)
    TrainingAnswerChoice.objects.filter(attempt=attempt).delete()

    for q in questions:
        raw_a_id = choices.get(q.id) if choices else None
        chosen_id: int | None = None
        is_correct = False
        if raw_a_id is not None:
            try:
                a_id = int(raw_a_id)
            except (TypeError, ValueError):
                raise TrainingValidationError(
                    f"Некорректный ответ для вопроса {q.id}.", field="choices"
                )
            row = answers_by_id.get(a_id)
            if row is None or row["question_id"] != q.id:
                raise TrainingValidationError(
                    f"Ответ {a_id} не относится к вопросу {q.id}.", field="choices"
                )
            chosen_id = a_id
            is_correct = bool(row["is_correct"])
        TrainingAnswerChoice.objects.create(
            attempt=attempt,
            question=q,
            chosen_answer_id=chosen_id,
            is_correct=is_correct,
        )
        if is_correct:
            correct_count += 1
        per_question.append(
            {
                "question_id": q.id,
                "correct": is_correct,
                "correct_answer_id": correct_answer_by_q.get(q.id),
                "chosen_answer_id": chosen_id,
            }
        )

    total = len(questions)
    attempt.score_pct = int(round(correct_count / total * 100)) if total else 0
    attempt.completed_at = timezone.now()
    attempt.save(update_fields=["score_pct", "completed_at", "updated_at"])

    return attempt, per_question


@transaction.atomic
def comment_add(*, operator: Operator, lesson_id: int, text: str) -> TrainingComment:
    text = (text or "").strip()
    if not text:
        raise TrainingValidationError("Комментарий не может быть пустым.", field="text")
    lesson = TrainingLesson.objects.filter(pk=lesson_id, is_active=True).first()
    if lesson is None:
        raise TrainingValidationError("Урок не найден или неактивен.", field="detail")
    return TrainingComment.objects.create(
        lesson=lesson, operator=operator, text=text
    )

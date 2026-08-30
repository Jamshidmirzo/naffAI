"""
Thin DRF views for the ``training`` app.

Все мутации идут через `services`; все выборки — через `selectors`. Здесь
только парсинг ввода, вызов service/selector, форматирование ответа.
"""

from __future__ import annotations

import json
from typing import Any

from rest_framework import serializers, status
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.operators.models import Operator
from apps.users.permissions import IsManager

from .models import TrainingAttempt, TrainingComment, TrainingLesson
from .permissions import IsOperatorWithProfile
from .selectors import (
    attempt_for,
    comments_for_lesson,
    lesson_get,
    lesson_stats,
    lessons_for_manager,
    lessons_for_operator,
    operator_attempts_map,
)
from .services import (
    TrainingValidationError,
    attempt_submit,
    comment_add,
    lesson_create,
    lesson_soft_delete,
    lesson_update,
)


# ---------- helpers: dict-serialization (тонкие; никакой бизнес-логики) ----------


def _serialize_lesson_manager(lesson: TrainingLesson) -> dict[str, Any]:
    questions = []
    for q in lesson.questions.all():
        questions.append(
            {
                "id": q.id,
                "text": q.text,
                "order": q.order,
                "answers": [
                    {
                        "id": a.id,
                        "text": a.text,
                        "is_correct": a.is_correct,
                        "order": a.order,
                    }
                    for a in q.answers.all()
                ],
            }
        )
    return {
        "id": lesson.id,
        "title": lesson.title,
        "description": lesson.description,
        "video_url": lesson.video_url,
        "file_url": lesson.file.url if lesson.file else "",
        "file_name": lesson.file.name.split("/")[-1] if lesson.file else "",
        "is_active": lesson.is_active,
        "created_at": lesson.created_at.isoformat(),
        "updated_at": lesson.updated_at.isoformat(),
        "questions": questions,
    }


def _serialize_lesson_operator(
    lesson: TrainingLesson, *, attempt: TrainingAttempt | None
) -> dict[str, Any]:
    questions = []
    for q in lesson.questions.all():
        questions.append(
            {
                "id": q.id,
                "text": q.text,
                "order": q.order,
                "answers": [
                    {"id": a.id, "text": a.text, "order": a.order}
                    for a in q.answers.all()
                ],
            }
        )
    attempt_out = None
    if attempt is not None and attempt.completed_at is not None:
        attempt_out = {
            "completed_at": attempt.completed_at.isoformat(),
            "score_pct": attempt.score_pct,
            # per-question: правильный ответ + что выбрал оператор — только
            # для завершённого attempt'а, чтобы не спойлерить активный тест.
            "per_question": [
                {
                    "question_id": c.question_id,
                    "chosen_answer_id": c.chosen_answer_id,
                    "is_correct": c.is_correct,
                }
                for c in attempt.choices.all()
            ],
        }
    return {
        "id": lesson.id,
        "title": lesson.title,
        "description": lesson.description,
        "video_url": lesson.video_url,
        "file_url": lesson.file.url if lesson.file else "",
        "file_name": lesson.file.name.split("/")[-1] if lesson.file else "",
        "created_at": lesson.created_at.isoformat(),
        "questions": questions,
        "attempt": attempt_out,
    }


def _serialize_comment(comment: TrainingComment) -> dict[str, Any]:
    return {
        "id": comment.id,
        "operator_id": comment.operator_id,
        "operator_name": comment.operator.full_name,
        "text": comment.text,
        "created_at": comment.created_at.isoformat(),
    }


# ---------- helpers ----------


def _operator_from_request(request) -> Operator | None:
    profile = getattr(request.user, "profile", None)
    if not profile or not profile.operator_id:
        return None
    return Operator.objects.filter(pk=profile.operator_id).first()


def _parse_questions_payload(raw: Any) -> list[dict] | None:
    """
    В `multipart/form-data` вложенные списки не парсятся автоматически —
    менеджер шлёт `questions` как JSON-строку. В `application/json`
    приходит готовый list. Возвращаем нормализованный list[dict] или None.
    """
    if raw is None:
        return None
    if isinstance(raw, str):
        raw = raw.strip()
        if not raw:
            return None
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            raise TrainingValidationError(
                "Некорректный JSON в поле questions.", field="questions"
            )
        if not isinstance(parsed, list):
            raise TrainingValidationError(
                "Поле questions должно быть списком.", field="questions"
            )
        return parsed
    if isinstance(raw, list):
        return raw
    raise TrainingValidationError(
        "Поле questions должно быть списком.", field="questions"
    )


def _bool_from_payload(raw: Any, *, default: bool = True) -> bool:
    if raw is None:
        return default
    if isinstance(raw, bool):
        return raw
    if isinstance(raw, str):
        return raw.strip().lower() in {"1", "true", "yes", "on"}
    return bool(raw)


# ---------- MANAGER endpoints ----------


class ManagerLessonListCreateApi(APIView):
    permission_classes = [IsAuthenticated, IsManager]
    # `MultiPartParser` уже стоит default для APIView; переопределять не нужно.

    def get(self, request):
        rows = []
        for lesson in lessons_for_manager():
            rows.append(
                {
                    "id": lesson.id,
                    "title": lesson.title,
                    "description": lesson.description,
                    "video_url": lesson.video_url,
                    "file_url": lesson.file.url if lesson.file else "",
                    "file_name": lesson.file.name.split("/")[-1] if lesson.file else "",
                    "is_active": lesson.is_active,
                    "questions_count": getattr(lesson, "questions_count", 0),
                    "attempts_count": getattr(lesson, "attempts_count", 0),
                    "comments_count": getattr(lesson, "comments_count", 0),
                    "created_at": lesson.created_at.isoformat(),
                }
            )
        return Response(rows)

    def post(self, request):
        try:
            questions = _parse_questions_payload(request.data.get("questions"))
            lesson = lesson_create(
                title=request.data.get("title", ""),
                description=request.data.get("description", ""),
                video_url=request.data.get("video_url", ""),
                file=request.FILES.get("file"),
                is_active=_bool_from_payload(request.data.get("is_active"), default=True),
                questions=questions,
                created_by=request.user,
            )
        except TrainingValidationError as e:
            return Response(e.as_dict(), status=status.HTTP_400_BAD_REQUEST)
        # Возвращаем свежий lesson с prefetch'ем questions/answers.
        lesson = lesson_get(lesson.id, include_inactive=True)
        return Response(
            _serialize_lesson_manager(lesson),
            status=status.HTTP_201_CREATED,
        )


class ManagerLessonDetailApi(APIView):
    permission_classes = [IsAuthenticated, IsManager]

    def get(self, request, pk: int):
        lesson = lesson_get(pk, include_inactive=True)
        if lesson is None:
            return Response({"detail": "Урок не найден."}, status=404)
        return Response(_serialize_lesson_manager(lesson))

    def patch(self, request, pk: int):
        try:
            questions = _parse_questions_payload(request.data.get("questions"))
            # `file`: если поле не передано вообще — не трогаем; если пришло
            # `clear_file=1` — очищаем; если пришёл новый файл — заменяем.
            file_kwargs: dict[str, Any] = {}
            if "file" in request.FILES:
                file_kwargs["file"] = request.FILES["file"]
            elif _bool_from_payload(request.data.get("clear_file"), default=False):
                file_kwargs["clear_file"] = True

            lesson = lesson_update(
                pk,
                title=request.data.get("title") if "title" in request.data else None,
                description=(
                    request.data.get("description") if "description" in request.data else None
                ),
                video_url=(
                    request.data.get("video_url") if "video_url" in request.data else None
                ),
                is_active=(
                    _bool_from_payload(request.data.get("is_active"), default=True)
                    if "is_active" in request.data
                    else None
                ),
                questions=questions,
                **file_kwargs,
            )
        except TrainingValidationError as e:
            return Response(e.as_dict(), status=status.HTTP_400_BAD_REQUEST)
        lesson = lesson_get(lesson.id, include_inactive=True)
        return Response(_serialize_lesson_manager(lesson))

    def delete(self, request, pk: int):
        try:
            lesson_soft_delete(pk)
        except TrainingValidationError as e:
            return Response(e.as_dict(), status=status.HTTP_404_NOT_FOUND)
        return Response(status=status.HTTP_204_NO_CONTENT)


class ManagerLessonStatsApi(APIView):
    permission_classes = [IsAuthenticated, IsManager]

    def get(self, request, pk: int):
        # Если урока нет — вернём shell вместо 404, чтобы фронт мог
        # рисовать «нет попыток» без спецкейса.
        return Response(lesson_stats(pk))


# ---------- OPERATOR endpoints ----------


class OperatorLessonListApi(APIView):
    permission_classes = [IsAuthenticated, IsOperatorWithProfile]

    def get(self, request):
        # Manager без operator_id тоже может открыть список (для preview);
        # attempt-статусы будут пустыми — это ок.
        operator = _operator_from_request(request)
        lessons = lessons_for_operator(operator) if operator else lessons_for_operator(Operator(id=-1))  # type: ignore[arg-type]
        # Если manager без operator_id — просто отдаём активные без статуса.
        if operator is None:
            attempts_map: dict[int, dict] = {}
            lessons = TrainingLesson.objects.filter(is_active=True).order_by(
                "-created_at"
            )
        else:
            attempts_map = operator_attempts_map(operator)

        rows = []
        for lesson in lessons:
            has_media = bool(lesson.video_url) or bool(lesson.file)
            info = attempts_map.get(lesson.id)
            rows.append(
                {
                    "id": lesson.id,
                    "title": lesson.title,
                    "description": lesson.description,
                    "has_video": bool(lesson.video_url),
                    "has_file": bool(lesson.file),
                    "has_media": has_media,
                    "questions_count": getattr(lesson, "questions_count", 0),
                    "comments_count": getattr(lesson, "comments_count", 0),
                    "created_at": lesson.created_at.isoformat(),
                    "attempt_completed": info is not None,
                    "score_pct": info["score_pct"] if info else None,
                }
            )
        return Response(rows)


class OperatorLessonDetailApi(APIView):
    permission_classes = [IsAuthenticated, IsOperatorWithProfile]

    def get(self, request, pk: int):
        lesson = lesson_get(pk, include_inactive=False)
        if lesson is None:
            return Response({"detail": "Урок не найден."}, status=404)
        operator = _operator_from_request(request)
        attempt = attempt_for(operator, pk) if operator else None
        return Response(_serialize_lesson_operator(lesson, attempt=attempt))


class OperatorLessonSubmitApi(APIView):
    permission_classes = [IsAuthenticated, IsOperatorWithProfile]

    class InputSerializer(serializers.Serializer):
        # {question_id: answer_id}. Значения ожидаются int, но принимаем str-ключи
        # (JSON object key всегда str) — сервис приведёт к int.
        choices = serializers.DictField(
            child=serializers.IntegerField(allow_null=True),
            allow_empty=True,
        )

    def post(self, request, pk: int):
        operator = _operator_from_request(request)
        if operator is None:
            return Response(
                {"detail": "У пользователя нет привязки к оператору."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        s = self.InputSerializer(data=request.data)
        s.is_valid(raise_exception=True)
        # Приводим ключи-строки к int (JSON dict keys — str).
        raw_choices = s.validated_data["choices"] or {}
        try:
            choices = {int(k): v for k, v in raw_choices.items()}
        except (TypeError, ValueError):
            return Response(
                {"choices": ["Ключи должны быть id вопросов (int)."]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        try:
            attempt, per_question = attempt_submit(
                operator=operator, lesson_id=pk, choices=choices
            )
        except TrainingValidationError as e:
            return Response(e.as_dict(), status=status.HTTP_400_BAD_REQUEST)

        return Response(
            {
                "score_pct": attempt.score_pct,
                "completed_at": attempt.completed_at.isoformat()
                if attempt.completed_at
                else None,
                "per_question": per_question,
            }
        )


class OperatorLessonCommentsApi(APIView):
    permission_classes = [IsAuthenticated, IsOperatorWithProfile]

    def get(self, request, pk: int):
        lesson = TrainingLesson.objects.filter(pk=pk, is_active=True).first()
        # Менеджеры тоже могут читать комментарии — permission пропускает.
        if lesson is None:
            # Не 404 — пустой список удобнее для UI при soft-deleted.
            return Response([])
        rows = [_serialize_comment(c) for c in comments_for_lesson(pk)]
        return Response(rows)

    class InputSerializer(serializers.Serializer):
        text = serializers.CharField(max_length=2000)

    def post(self, request, pk: int):
        operator = _operator_from_request(request)
        if operator is None:
            return Response(
                {"detail": "У пользователя нет привязки к оператору."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        s = self.InputSerializer(data=request.data)
        s.is_valid(raise_exception=True)
        try:
            comment = comment_add(
                operator=operator,
                lesson_id=pk,
                text=s.validated_data["text"],
            )
        except TrainingValidationError as e:
            return Response(e.as_dict(), status=status.HTTP_400_BAD_REQUEST)
        return Response(
            _serialize_comment(comment), status=status.HTTP_201_CREATED
        )

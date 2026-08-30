"""
Data shapes for the ``training`` app.

Manager-authored training lessons (не путать с legacy `apps.lessons`
`DailyLesson` — там AI-генерированный personal insight на день). Здесь —
общие обучающие материалы: title + video/file + опциональный тест +
опциональные комментарии.
"""

from __future__ import annotations

from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import models

from apps.common.models import TimestampedModel


class TrainingLesson(TimestampedModel):
    """Один обучающий материал. Требуется минимум одно из: video_url / file."""

    title = models.CharField(max_length=200)
    description = models.TextField(blank=True, default="")
    video_url = models.URLField(blank=True, default="")
    file = models.FileField(
        upload_to="training/%Y/%m/",
        blank=True,
        null=True,
        help_text="Опциональный файл-приложение (PDF/PPTX/…).",
    )
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="+",
    )
    # Soft-delete: удалять полностью нельзя, иначе теряем TrainingAttempt
    # /TrainingAnswerChoice истории. `is_active=False` скрывает урок от
    # операторов; менеджер по-прежнему видит его в /manage.
    is_active = models.BooleanField(default=True, db_index=True)

    class Meta:
        ordering = ["-created_at"]

    def __str__(self) -> str:
        return self.title

    def clean(self):
        """
        Валидация «медиа обязательно». Явно вызывается из service,
        а также срабатывает в admin. Пустой URL == пустая строка, а не
        None — сравниваем как truthy string.
        """
        super().clean()
        has_video = bool((self.video_url or "").strip())
        has_file = bool(self.file)
        if not has_video and not has_file:
            raise ValidationError(
                {"video_url": "Укажите video_url или прикрепите файл (хотя бы одно)."}
            )


class TrainingQuestion(TimestampedModel):
    lesson = models.ForeignKey(
        TrainingLesson, related_name="questions", on_delete=models.CASCADE
    )
    text = models.TextField()
    order = models.PositiveSmallIntegerField(default=0)

    class Meta:
        ordering = ["order", "id"]

    def __str__(self) -> str:
        return f"Q{self.pk} of lesson {self.lesson_id}"


class TrainingAnswer(TimestampedModel):
    question = models.ForeignKey(
        TrainingQuestion, related_name="answers", on_delete=models.CASCADE
    )
    text = models.CharField(max_length=500)
    is_correct = models.BooleanField(default=False)
    order = models.PositiveSmallIntegerField(default=0)

    class Meta:
        ordering = ["order", "id"]

    def __str__(self) -> str:
        return f"A{self.pk} of question {self.question_id}"


class TrainingAttempt(TimestampedModel):
    """
    Одна попытка оператора на один урок. Уникальность
    (lesson, operator) — один raw-attempt на пару. Пересдача не
    поддерживается в MVP (иначе накрывается статистика ошибок).
    """

    lesson = models.ForeignKey(
        TrainingLesson, related_name="attempts", on_delete=models.CASCADE
    )
    operator = models.ForeignKey(
        "operators.Operator",
        related_name="training_attempts",
        on_delete=models.CASCADE,
    )
    completed_at = models.DateTimeField(null=True, blank=True)
    score_pct = models.PositiveSmallIntegerField(null=True, blank=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["lesson", "operator"],
                name="unique_training_attempt_per_operator",
            ),
        ]
        indexes = [
            models.Index(fields=["lesson", "operator"]),
        ]

    def __str__(self) -> str:
        return f"Attempt({self.operator_id} on {self.lesson_id}, {self.score_pct}%)"


class TrainingAnswerChoice(TimestampedModel):
    """
    Ответ оператора на конкретный вопрос в рамках попытки. `is_correct`
    хранится денормализовано — переизбранный ответ пишет свежий флаг,
    даже если позже менеджер поменяет is_correct у самого TrainingAnswer.
    Это делает статистику ошибок стабильной относительно правок урока
    задним числом.
    """

    attempt = models.ForeignKey(
        TrainingAttempt, related_name="choices", on_delete=models.CASCADE
    )
    question = models.ForeignKey(
        TrainingQuestion,
        related_name="choices",
        on_delete=models.CASCADE,
    )
    chosen_answer = models.ForeignKey(
        TrainingAnswer,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="+",
    )
    is_correct = models.BooleanField(default=False)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["attempt", "question"],
                name="unique_choice_per_attempt_question",
            ),
        ]

    def __str__(self) -> str:
        return (
            f"Choice(attempt={self.attempt_id}, q={self.question_id}, "
            f"correct={self.is_correct})"
        )


class TrainingComment(TimestampedModel):
    """Комментарий оператора к уроку. Виден и коллегам, и менеджеру."""

    lesson = models.ForeignKey(
        TrainingLesson, related_name="comments", on_delete=models.CASCADE
    )
    operator = models.ForeignKey(
        "operators.Operator",
        related_name="training_comments",
        on_delete=models.CASCADE,
    )
    text = models.TextField()

    class Meta:
        ordering = ["-created_at"]

    def __str__(self) -> str:
        return f"Comment({self.operator_id} on {self.lesson_id})"

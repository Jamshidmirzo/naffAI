from django.db import models
from django.conf import settings
from apps.common.models import TimestampedModel


class DailyLesson(TimestampedModel):
    operator = models.ForeignKey(
        "operators.Operator", on_delete=models.CASCADE, related_name="lessons"
    )
    lesson_date = models.DateField(help_text="Дата, ЗА которую урок (вчера на момент генерации)")

    # AI-контент (legacy v1 shape — оставлен для back-compat со старыми уроками).
    summary = models.TextField(help_text="Абзац: как прошёл день", blank=True, default="")
    highlights = models.JSONField(default=list, help_text="[{title, evidence}] — 2-3 сильные стороны")
    tips = models.JSONField(default=list, help_text="[{title, why, example, action}] — 3 совета")
    micro_lesson = models.CharField(
        max_length=280,
        help_text="Один узкий навык на сегодня: 'уточняй бюджет до презентации модели'"
    )

    # AI-контент v2 — новая расширенная схема (greeting_line, yesterday_summary,
    # main_insight, blockers[example], practice_today[when/how], closing_line).
    # Пустой dict = урок в v1-схеме. Frontend читает `content` (если непусто) → v2,
    # иначе рендерит legacy summary+highlights+tips.
    content = models.JSONField(
        default=dict, blank=True,
        help_text=(
            "Полный JSON нового v2 промпта: {greeting_line, yesterday_summary, "
            "main_insight{title,text}, highlights[{title,evidence}], "
            "blockers[{title,why,example}], practice_today[{step,when,how}], "
            "micro_lesson, closing_line}. Пустой dict = старый v1 урок."
        ),
    )

    # Язык, на котором сгенерирован урок. Определяется по
    # `operator.linked_profile.preferred_language` в момент генерации.
    # Старые уроки без явного значения помечаются 'ru' (первый релиз был
    # только на русском).
    language = models.CharField(
        max_length=8,
        default="ru",
        help_text="Язык AI-контента: 'ru' или 'uz'.",
    )

    # Числовой снапшот вчерашнего дня (для UI без пересчёта)
    stats_snapshot = models.JSONField(
        default=dict,
        help_text="{sales_count, revenue_uzs, avg_check, dialogs_count, avg_quality, "
                  "callbacks_missed, leads_won, leads_lost, month_progress_pct}"
    )

    # AI-мета (из TgAiInsight — тот же паттерн)
    model_version = models.CharField(max_length=64)
    prompt_version = models.CharField(max_length=16)

    # Доставка
    delivered_at = models.DateTimeField(null=True, blank=True, help_text="Когда упало в TG-DM")
    opened_at = models.DateTimeField(null=True, blank=True, help_text="Когда оператор открыл в UI")

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["operator", "lesson_date"],
                name="unique_lesson_per_operator_per_day",
            ),
        ]
        indexes = [
            models.Index(fields=["operator", "-lesson_date"]),
        ]

    def __str__(self) -> str:
        return f"DailyLesson({self.operator_id}, {self.lesson_date})"


class DailyLessonAttempt(TimestampedModel):
    operator = models.ForeignKey("operators.Operator", on_delete=models.CASCADE)
    lesson_date = models.DateField()
    status = models.CharField(
        max_length=10,
        choices=[("ok", "ok"), ("skip", "skip"), ("error", "error")],
    )
    reason = models.CharField(max_length=280, blank=True)
    model_version = models.CharField(max_length=64, blank=True)
    duration_ms = models.PositiveIntegerField(default=0)
    delivered_at = models.DateTimeField(null=True, blank=True, help_text="Когда отправлен TG-DM для skipped/empty дней")

    def __str__(self) -> str:
        return f"DailyLessonAttempt({self.operator_id}, {self.lesson_date}, {self.status})"


class DailyLessonFeedbackRating(models.TextChoices):
    HELPFUL = "helpful", "Полезно"
    NOT_HELPFUL = "not_helpful", "Не полезно"


class DailyLessonFeedback(TimestampedModel):
    """
    Оценка урока оператором (👍/👎 + опциональный текст). Собираем данные
    для будущих A/B-промптов и ретроспективного тюнинга. Один оператор
    может переоценить свой урок (unique per lesson) — оставляем последнюю
    запись через update_or_create в service.
    """
    lesson = models.OneToOneField(
        DailyLesson, on_delete=models.CASCADE, related_name="feedback"
    )
    rating = models.CharField(max_length=16, choices=DailyLessonFeedbackRating.choices)
    comment = models.TextField(blank=True, default="")
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True, blank=True,
        on_delete=models.SET_NULL,
        related_name="+",
    )

    def __str__(self) -> str:
        return f"DailyLessonFeedback(lesson={self.lesson_id}, rating={self.rating})"

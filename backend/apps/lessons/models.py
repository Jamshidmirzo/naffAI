from django.db import models
from apps.common.models import TimestampedModel


class DailyLesson(TimestampedModel):
    operator = models.ForeignKey(
        "operators.Operator", on_delete=models.CASCADE, related_name="lessons"
    )
    lesson_date = models.DateField(help_text="Дата, ЗА которую урок (вчера на момент генерации)")

    # AI-контент
    summary = models.TextField(help_text="Абзац: как прошёл день")
    highlights = models.JSONField(default=list, help_text="[{title, evidence}] — 2-3 сильные стороны")
    tips = models.JSONField(default=list, help_text="[{title, why, example, action}] — 3 совета")
    micro_lesson = models.CharField(
        max_length=280,
        help_text="Один узкий навык на сегодня: 'уточняй бюджет до презентации модели'"
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

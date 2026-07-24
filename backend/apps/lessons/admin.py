from django.contrib import admin
from .models import DailyLesson, DailyLessonAttempt


@admin.register(DailyLesson)
class DailyLessonAdmin(admin.ModelAdmin):
    list_display = (
        "id",
        "operator",
        "lesson_date",
        "micro_lesson",
        "delivered_at",
        "opened_at",
        "created_at",
    )
    list_filter = ("lesson_date", "operator")
    search_fields = ("operator__full_name", "summary", "micro_lesson")
    raw_id_fields = ("operator",)


@admin.register(DailyLessonAttempt)
class DailyLessonAttemptAdmin(admin.ModelAdmin):
    list_display = (
        "id",
        "operator",
        "lesson_date",
        "status",
        "reason",
        "duration_ms",
        "created_at",
    )
    list_filter = ("status", "lesson_date", "operator")
    search_fields = ("operator__full_name", "reason")
    raw_id_fields = ("operator",)

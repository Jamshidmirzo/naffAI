from django.urls import path
from .apis import (
    DetailLessonApi,
    HistoryLessonApi,
    TodayLessonApi,
    TodayLessonFeedbackApi,
)

urlpatterns = [
    path("", DetailLessonApi.as_view(), name="lesson-detail"),
    path("today/", TodayLessonApi.as_view(), name="lesson-today"),
    path("today/feedback/", TodayLessonFeedbackApi.as_view(), name="lesson-today-feedback"),
    path("history/", HistoryLessonApi.as_view(), name="lesson-history"),
]

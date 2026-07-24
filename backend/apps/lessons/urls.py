from django.urls import path
from .apis import TodayLessonApi, HistoryLessonApi, DetailLessonApi

urlpatterns = [
    path("", DetailLessonApi.as_view(), name="lesson-detail"),
    path("today/", TodayLessonApi.as_view(), name="lesson-today"),
    path("history/", HistoryLessonApi.as_view(), name="lesson-history"),
]

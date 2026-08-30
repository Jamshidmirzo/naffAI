from django.urls import path

from .apis import (
    ManagerLessonDetailApi,
    ManagerLessonListCreateApi,
    ManagerLessonStatsApi,
    OperatorLessonCommentsApi,
    OperatorLessonDetailApi,
    OperatorLessonListApi,
    OperatorLessonSubmitApi,
)

# Mounted under /api/training/  (см. config/api_urls.py).
urlpatterns = [
    # Manager side ---------------------------------------------------------
    path("lessons/", ManagerLessonListCreateApi.as_view(), name="training-manager-list"),
    path(
        "lessons/<int:pk>/",
        ManagerLessonDetailApi.as_view(),
        name="training-manager-detail",
    ),
    path(
        "lessons/<int:pk>/stats/",
        ManagerLessonStatsApi.as_view(),
        name="training-manager-stats",
    ),
    # Operator side --------------------------------------------------------
    path("my-lessons/", OperatorLessonListApi.as_view(), name="training-operator-list"),
    path(
        "my-lessons/<int:pk>/",
        OperatorLessonDetailApi.as_view(),
        name="training-operator-detail",
    ),
    path(
        "my-lessons/<int:pk>/submit/",
        OperatorLessonSubmitApi.as_view(),
        name="training-operator-submit",
    ),
    path(
        "my-lessons/<int:pk>/comments/",
        OperatorLessonCommentsApi.as_view(),
        name="training-operator-comments",
    ),
]

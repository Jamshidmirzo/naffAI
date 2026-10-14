from django.urls import path

from .apis import (
    DayOffApproveApi,
    DayOffContextApi,
    DayOffCreateApi,
    DayOffPendingListApi,
    DayOffRejectApi,
    DeletedOperatorsListApi,
    MePreferencesApi,
    MyDayOffListApi,
    OperatorAvatarApi,
    OperatorDeactivateApi,
    OperatorDeleteApi,
    OperatorDetailApi,
    OperatorListCreateApi,
    OperatorMeAvatarApi,
    OperatorPauseApi,
    OperatorPlanApi,
    OperatorReactivateApi,
    OperatorSnapshotRequestApi,
    OperatorStatsApi,
    OperatorsBirthdayTodayApi,
)

urlpatterns = [
    path("", OperatorListCreateApi.as_view()),
    # NB: конкретные пути ДОЛЖНЫ идти ДО `<int:pk>/`, иначе Django/DRF
    # съест «birthdays-today» как pk и упадёт с 404.
    path("birthdays-today/", OperatorsBirthdayTodayApi.as_view()),
    path("deleted/", DeletedOperatorsListApi.as_view()),
    # Day-off requests — static paths ДО <int:pk>/.
    path("day-off/", DayOffCreateApi.as_view()),
    path("day-off/pending/", DayOffPendingListApi.as_view()),
    path("day-off/<int:pk>/context/", DayOffContextApi.as_view()),
    path("day-off/<int:pk>/approve/", DayOffApproveApi.as_view()),
    path("day-off/<int:pk>/reject/", DayOffRejectApi.as_view()),
    # Avatar / snapshot — static-ish paths перед generic <int:pk>/.
    # `me/avatar/` ловится здесь напрямую (строковый сегмент не
    # подойдёт под <int:pk>) — оператор загружает свой снимок.
    path("me/avatar/", OperatorMeAvatarApi.as_view(), name="operator-me-avatar"),
    path("<int:pk>/avatar/", OperatorAvatarApi.as_view()),
    path("<int:pk>/snapshot/request/", OperatorSnapshotRequestApi.as_view()),
    path("<int:pk>/", OperatorDetailApi.as_view()),
    path("<int:pk>/stats/", OperatorStatsApi.as_view()),
    path("<int:pk>/plan/", OperatorPlanApi.as_view()),
    path("<int:pk>/deactivate/", OperatorDeactivateApi.as_view()),
    path("<int:pk>/reactivate/", OperatorReactivateApi.as_view()),
    path("<int:pk>/pause/", OperatorPauseApi.as_view(paused=True)),
    path("<int:pk>/unpause/", OperatorPauseApi.as_view(paused=False)),
    path("<int:operator_id>/delete/", OperatorDeleteApi.as_view()),
]


# Mounted at /api/me/ via config.api_urls — self-service preferences for
# operators (notification opt-outs, etc). Kept separate from `urlpatterns`
# so it doesn't collide with /operators/<pk>/... routes.
me_urlpatterns = [
    path("preferences/", MePreferencesApi.as_view(), name="me-preferences"),
    path("day-off/", MyDayOffListApi.as_view(), name="me-day-off"),
]



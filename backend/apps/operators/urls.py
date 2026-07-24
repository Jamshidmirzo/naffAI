from django.urls import path

from .apis import (
    MePreferencesApi,
    OperatorDeactivateApi,
    OperatorDeleteApi,
    OperatorDetailApi,
    OperatorListCreateApi,
    OperatorPlanApi,
    OperatorReactivateApi,
    OperatorStatsApi,
)

urlpatterns = [
    path("", OperatorListCreateApi.as_view()),
    path("<int:pk>/", OperatorDetailApi.as_view()),
    path("<int:pk>/stats/", OperatorStatsApi.as_view()),
    path("<int:pk>/plan/", OperatorPlanApi.as_view()),
    path("<int:pk>/deactivate/", OperatorDeactivateApi.as_view()),
    path("<int:pk>/reactivate/", OperatorReactivateApi.as_view()),
    path("<int:operator_id>/delete/", OperatorDeleteApi.as_view()),
]


# Mounted at /api/me/ via config.api_urls — self-service preferences for
# operators (notification opt-outs, etc). Kept separate from `urlpatterns`
# so it doesn't collide with /operators/<pk>/... routes.
me_urlpatterns = [
    path("preferences/", MePreferencesApi.as_view(), name="me-preferences"),
]

from django.urls import path

from .apis import (
    OperatorDeactivateApi,
    OperatorDeleteApi,
    OperatorDetailApi,
    OperatorListCreateApi,
    OperatorReactivateApi,
)

urlpatterns = [
    path("", OperatorListCreateApi.as_view()),
    path("<int:pk>/", OperatorDetailApi.as_view()),
    path("<int:pk>/deactivate/", OperatorDeactivateApi.as_view()),
    path("<int:pk>/reactivate/", OperatorReactivateApi.as_view()),
    path("<int:operator_id>/delete/", OperatorDeleteApi.as_view()),
]

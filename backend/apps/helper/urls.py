from django.urls import path

from .apis import OperatorHelperApi

urlpatterns = [
    path("operator-suggestions/", OperatorHelperApi.as_view()),
]

from django.urls import path

from .apis import GenerateInsightApi, InsightsListApi, LatestInsightApi

urlpatterns = [
    path("insights/", InsightsListApi.as_view()),
    path("insights/latest/", LatestInsightApi.as_view()),
    path("insights/generate/", GenerateInsightApi.as_view()),
]

from django.urls import path

from .apis import (
    AnalyticsExportApi,
    ByChannelApi,
    ByModelApi,
    KpiApi,
    LeaderboardApi,
    TimeseriesApi,
)

urlpatterns = [
    path("kpi/", KpiApi.as_view()),
    path("leaderboard/", LeaderboardApi.as_view()),
    path("by-channel/", ByChannelApi.as_view()),
    path("by-model/", ByModelApi.as_view()),
    path("timeseries/", TimeseriesApi.as_view()),
    path("export.xlsx", AnalyticsExportApi.as_view()),
]

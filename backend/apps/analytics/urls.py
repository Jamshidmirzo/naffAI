from django.urls import path

from .apis import (
    AnalyticsExportApi,
    ByChannelApi,
    ByModelApi,
    BySourceApi,
    CallbackHeatmapApi,
    DashboardSummaryApi,
    KpiApi,
    LeaderboardApi,
    LeadStatsApi,
    LeadsDistributionApi,
    OperatorFunnelsApi,
    TimeseriesApi,
)

urlpatterns = [
    path("kpi/", KpiApi.as_view()),
    path("leaderboard/", LeaderboardApi.as_view()),
    path("by-channel/", ByChannelApi.as_view()),
    path("by-model/", ByModelApi.as_view()),
    path("by-source/", BySourceApi.as_view()),
    path("timeseries/", TimeseriesApi.as_view()),
    path("leads-distribution/", LeadsDistributionApi.as_view()),
    path("operator-funnels/", OperatorFunnelsApi.as_view()),
    path("callback-heatmap/", CallbackHeatmapApi.as_view()),
    path("lead-stats/", LeadStatsApi.as_view()),
    # Единый aggregate под менеджерский Dashboard «Сводка дня».
    path("dashboard-summary/", DashboardSummaryApi.as_view()),
    path("export.xlsx", AnalyticsExportApi.as_view()),
]

from django.urls import path

from .apis import (
    AdSpendDetailApi,
    AdSpendListCreateApi,
    GenerateInsightApi,
    InsightDetailApi,
    InsightsListApi,
    LatestInsightApi,
    MarketingDashboardApi,
    MarketingExportApi,
    MarkRecommendationDoneApi,
)

urlpatterns = [
    # Legacy
    path("insights/", InsightsListApi.as_view()),
    path("insights/latest/", LatestInsightApi.as_view()),
    path("insights/generate/", GenerateInsightApi.as_view()),
    path("insights/<int:insight_id>/", InsightDetailApi.as_view()),
    path(
        "insights/<int:insight_id>/recommendations/<int:index>/mark_done/",
        MarkRecommendationDoneApi.as_view(),
    ),

    # Rich dashboard
    path("dashboard/", MarketingDashboardApi.as_view()),
    path("export.xlsx/", MarketingExportApi.as_view()),

    # AdSpend CRUD
    path("adspend/", AdSpendListCreateApi.as_view()),
    path("adspend/<int:adspend_id>/", AdSpendDetailApi.as_view()),
]

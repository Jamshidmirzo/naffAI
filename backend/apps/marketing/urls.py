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
from .smm_apis import (
    MetaAdAccountDetailApi,
    MetaAdAccountListApi,
    MetaAdAccountSyncApi,
    MetaConnectionCheckApi,
    MetaConnectionDetailApi,
    MetaConnectionListCreateApi,
    MetaPageDetailApi,
    MetaPageListApi,
    MetaPageSyncApi,
    SmmDashboardApi,
    SmmLeadsApi,
    SmmListApi,
    SmmOverviewApi,
    SmmSourcesApi,
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

    # SMM-специалисты (таргетологи) + Meta Ads
    path("smm/", SmmListApi.as_view()),
    path("smm/overview/", SmmOverviewApi.as_view()),
    path("smm/dashboard/", SmmDashboardApi.as_view()),
    path("smm/leads/", SmmLeadsApi.as_view()),
    path("smm/<int:smm_id>/sources/", SmmSourcesApi.as_view()),
    path("meta/connections/", MetaConnectionListCreateApi.as_view()),
    path("meta/connections/<int:connection_id>/", MetaConnectionDetailApi.as_view()),
    path("meta/connections/<int:connection_id>/check/", MetaConnectionCheckApi.as_view()),
    path("meta/ad-accounts/", MetaAdAccountListApi.as_view()),
    path("meta/ad-accounts/<int:account_id>/", MetaAdAccountDetailApi.as_view()),
    path("meta/ad-accounts/<int:account_id>/sync/", MetaAdAccountSyncApi.as_view()),
    path("meta/pages/", MetaPageListApi.as_view()),
    path("meta/pages/<int:page_id>/", MetaPageDetailApi.as_view()),
    path("meta/pages/<int:page_id>/sync/", MetaPageSyncApi.as_view()),
]

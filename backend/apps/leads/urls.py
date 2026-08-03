from django.urls import path

from .apis import (
    DistributeNowApi,
    DistributionStatusApi,
    LeadConvertToSaleApi,
    LeadDetailApi,
    LeadListCreateApi,
    LeadMyListApi,
    LeadPostponeApi,
    LeadReassignApi,
    LeadsBulkReassignApi,
    LeadStatusApi,
    LeadStatusLabelDetailApi,
    LeadStatusLabelListCreateApi,
    LeadUnpostponeApi,
    OperatorSheetAliasDetailApi,
    OperatorSheetAliasListCreateApi,
    OrphanLeadsApi,
    SheetSourceDetailApi,
    SheetSourceListCreateApi,
    TelegramLookupApi,
)

urlpatterns = [
    path("", LeadListCreateApi.as_view()),
    path("my/", LeadMyListApi.as_view()),
    # Static paths ставим ПЕРЕД <int:pk>/, чтобы `orphans` / `bulk-reassign` /
    # `distribution-status` / `distribute-now` не матчились как ID.
    path("orphans/", OrphanLeadsApi.as_view()),
    path("bulk-reassign/", LeadsBulkReassignApi.as_view()),
    path("distribution-status/", DistributionStatusApi.as_view()),
    path("distribute-now/", DistributeNowApi.as_view()),
    path("<int:pk>/", LeadDetailApi.as_view()),
    path("<int:pk>/reassign/", LeadReassignApi.as_view()),
    path("<int:pk>/status/", LeadStatusApi.as_view()),
    path("<int:pk>/postpone/", LeadPostponeApi.as_view()),
    path("<int:pk>/unpostpone/", LeadUnpostponeApi.as_view()),
    path("<int:pk>/convert-to-sale/", LeadConvertToSaleApi.as_view()),
]


sheet_source_urlpatterns = [
    path("", SheetSourceListCreateApi.as_view()),
    path("<int:pk>/", SheetSourceDetailApi.as_view()),
]

alias_urlpatterns = [
    path("", OperatorSheetAliasListCreateApi.as_view()),
    path("<int:pk>/", OperatorSheetAliasDetailApi.as_view()),
]

telegram_urlpatterns = [
    path("lookup/", TelegramLookupApi.as_view()),
]

lead_status_urlpatterns = [
    path("", LeadStatusLabelListCreateApi.as_view()),
    path("<int:pk>/", LeadStatusLabelDetailApi.as_view()),
]

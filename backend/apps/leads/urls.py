from django.urls import path

from .apis import (
    LeadConvertToSaleApi,
    LeadDetailApi,
    LeadListCreateApi,
    LeadMyListApi,
    LeadReassignApi,
    LeadStatusApi,
    OperatorSheetAliasDetailApi,
    OperatorSheetAliasListCreateApi,
    SheetSourceDetailApi,
    SheetSourceListCreateApi,
    TelegramLookupApi,
)

urlpatterns = [
    path("", LeadListCreateApi.as_view()),
    path("my/", LeadMyListApi.as_view()),
    path("<int:pk>/", LeadDetailApi.as_view()),
    path("<int:pk>/reassign/", LeadReassignApi.as_view()),
    path("<int:pk>/status/", LeadStatusApi.as_view()),
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

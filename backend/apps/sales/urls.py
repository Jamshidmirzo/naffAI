from django.urls import path

from .apis import (
    SaleBulkActionApi,
    SaleConfirmApi,
    SaleDetailApi,
    SaleImportExcelApi,
    SaleListCreateApi,
    SalePendingListApi,
    SaleRejectApi,
    SaleReturnApi,
)
from .export_apis import SaleExportApi

urlpatterns = [
    path("", SaleListCreateApi.as_view()),
    path("export.xlsx", SaleExportApi.as_view()),
    path("import-excel/", SaleImportExcelApi.as_view()),
    # Static paths BEFORE <int:pk>/ so `pending` isn't parsed as an id.
    path("pending/", SalePendingListApi.as_view()),
    path("bulk-confirm/", SaleBulkActionApi.as_view()),
    path("<int:pk>/", SaleDetailApi.as_view()),
    path("<int:pk>/return/", SaleReturnApi.as_view()),
    path("<int:pk>/confirm/", SaleConfirmApi.as_view()),
    path("<int:pk>/reject/", SaleRejectApi.as_view()),
]

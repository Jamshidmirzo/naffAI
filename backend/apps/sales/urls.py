from django.urls import path

from .apis import (
    SaleConfirmApi,
    SaleDetailApi,
    SaleListCreateApi,
    SaleReturnApi,
)
from .export_apis import SaleExportApi

urlpatterns = [
    path("", SaleListCreateApi.as_view()),
    path("export.xlsx", SaleExportApi.as_view()),
    path("<int:pk>/", SaleDetailApi.as_view()),
    path("<int:pk>/return/", SaleReturnApi.as_view()),
    path("<int:pk>/confirm/", SaleConfirmApi.as_view()),
]

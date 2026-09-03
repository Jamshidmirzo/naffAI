from django.urls import path

from .apis import DistributionSettingsApi, RetryExportStatusesApi

urlpatterns = [
    path("distribution/", DistributionSettingsApi.as_view(), name="distribution-settings"),
    path(
        "retry-export/",
        RetryExportStatusesApi.as_view(),
        name="retry-export-statuses",
    ),
]

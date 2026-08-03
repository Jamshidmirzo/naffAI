from django.urls import path

from .apis import DistributionSettingsApi

urlpatterns = [
    path("distribution/", DistributionSettingsApi.as_view(), name="distribution-settings"),
]

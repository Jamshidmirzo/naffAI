from django.urls import path

from .apis import (
    MobileLeadDetailApi,
    MobileLeadStatusApi,
    MobileLoginApi,
    MobileMeApi,
    MobileMyLeadsApi,
    MobileRefreshApi,
)


# Mounted at /api/auth/ from config.api_urls.
auth_urlpatterns = [
    path("mobile-login/", MobileLoginApi.as_view(), name="mobile-login"),
    path("mobile-refresh/", MobileRefreshApi.as_view(), name="mobile-refresh"),
]


# Mounted at /api/mobile/ from config.api_urls.
mobile_urlpatterns = [
    path("me/", MobileMeApi.as_view(), name="mobile-me"),
    path("leads/my/", MobileMyLeadsApi.as_view(), name="mobile-my-leads"),
    path("leads/<int:pk>/", MobileLeadDetailApi.as_view(), name="mobile-lead-detail"),
    path(
        "leads/<int:pk>/status/",
        MobileLeadStatusApi.as_view(),
        name="mobile-lead-status",
    ),
]

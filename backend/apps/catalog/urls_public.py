"""
Public catalog for the shop website — mounted at /api/public/catalog/.
Read-only, `X-Site-Key` protected (see apis_public).
"""

from django.urls import path

from .apis_public import PublicPhoneDetailApi, PublicPhoneListApi, PublicStoreApi

urlpatterns = [
    path("phones/", PublicPhoneListApi.as_view(), name="phone-list"),
    path("phones/<slug:slug>/", PublicPhoneDetailApi.as_view(), name="phone-detail"),
    path("store/", PublicStoreApi.as_view(), name="store"),
]

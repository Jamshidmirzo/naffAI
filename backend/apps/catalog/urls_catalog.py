from django.urls import include, path
from rest_framework.routers import DefaultRouter

from .apis_installment import InstallmentBankViewSet, InstallmentPlanViewSet
from .apis_marketing import (
    InstallmentCalculatorApi,
    InstallmentTierViewSet,
    MarketingSettingsApi,
    PhoneMarketingTextApi,
)
from .apis_phones import PhoneModelViewSet

router = DefaultRouter()
router.register(r"phones", PhoneModelViewSet, basename="catalog-phones")
router.register(
    r"installment/banks", InstallmentBankViewSet, basename="catalog-installment-banks"
)
router.register(
    r"installment/plans", InstallmentPlanViewSet, basename="catalog-installment-plans"
)
router.register(
    r"installment-tiers", InstallmentTierViewSet, basename="catalog-installment-tiers"
)

urlpatterns = [
    path("", include(router.urls)),
    path(
        "phones/<int:phone_id>/marketing/",
        PhoneMarketingTextApi.as_view(),
        name="catalog-phone-marketing",
    ),
    path(
        "calculate/",
        InstallmentCalculatorApi.as_view(),
        name="catalog-calculate",
    ),
    path(
        "marketing-settings/",
        MarketingSettingsApi.as_view(),
        name="catalog-marketing-settings",
    ),
]

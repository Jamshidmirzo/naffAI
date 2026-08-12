from django.urls import include, path
from rest_framework.routers import DefaultRouter

from .apis_installment import InstallmentBankViewSet, InstallmentPlanViewSet
from .apis_phones import PhoneModelViewSet

router = DefaultRouter()
router.register(r"phones", PhoneModelViewSet, basename="catalog-phones")
router.register(
    r"installment/banks", InstallmentBankViewSet, basename="catalog-installment-banks"
)
router.register(
    r"installment/plans", InstallmentPlanViewSet, basename="catalog-installment-plans"
)

urlpatterns = [
    path("", include(router.urls)),
]

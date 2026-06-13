from django.urls import include, path

urlpatterns = [
    path("auth/", include("apps.users.urls")),
    path("operators/", include("apps.operators.urls")),
    path("channels/", include("apps.catalog.urls_channels")),
    path("imei/", include("apps.catalog.urls_imei")),
    path("sales/", include("apps.sales.urls")),
    path("payroll/", include("apps.payroll.urls")),
    path("analytics/", include("apps.analytics.urls")),
    path("audit/", include("apps.audit.urls")),
]

from django.urls import include, path

from apps.calls.urls import (
    callback_urlpatterns,
    lead_nested_urlpatterns,
)
from apps.leads.urls import (
    alias_urlpatterns,
    sheet_source_urlpatterns,
    telegram_urlpatterns,
)


urlpatterns = [
    path("auth/", include("apps.users.urls")),
    path("operators/", include("apps.operators.urls")),
    path("channels/", include("apps.catalog.urls_channels")),
    path("imei/", include("apps.catalog.urls_imei")),
    path("sales/", include("apps.sales.urls")),
    path("payroll/", include("apps.payroll.urls")),
    path("analytics/", include("apps.analytics.urls")),
    path("audit/", include("apps.audit.urls")),
    # Pre-sale contour (Этап A):
    #  - /leads/*         CRUD + reassign + convert-to-sale + operator's own list
    #  - /leads/<pk>/call-attempts/  + /leads/<pk>/callbacks/  (nested)
    #  - /callbacks/*     mine / due / done / snooze
    #  - /sheet-sources/, /operator-sheet-aliases/  (sheet mapping admin)
    #  - /telegram/lookup, /telegram/lookup (POST upsert)
    path("leads/", include("apps.leads.urls")),
    path("leads/", include((lead_nested_urlpatterns, "calls_nested"))),
    path("callbacks/", include((callback_urlpatterns, "callbacks"))),
    path("sheet-sources/", include((sheet_source_urlpatterns, "sheet_sources"))),
    path("operator-sheet-aliases/", include((alias_urlpatterns, "operator_sheet_aliases"))),
    path("telegram/", include((telegram_urlpatterns, "telegram"))),
]

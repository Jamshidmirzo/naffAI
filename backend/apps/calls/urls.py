from django.urls import path

from .apis import (
    CallbackDoneApi,
    CallbackMineDueApi,
    CallbackMineListApi,
    CallbackSnoozeApi,
    LeadCallAttemptCreateApi,
    LeadCallbackCreateApi,
    MyActivityReportApi,
)

# Endpoints nested under /api/leads/<pk>/…
lead_nested_urlpatterns = [
    path("<int:pk>/call-attempts/", LeadCallAttemptCreateApi.as_view()),
    path("<int:pk>/callbacks/", LeadCallbackCreateApi.as_view()),
]


# Endpoints under /api/callbacks/…
callback_urlpatterns = [
    path("mine/", CallbackMineListApi.as_view()),
    path("mine/due/", CallbackMineDueApi.as_view()),
    path("<int:pk>/done/", CallbackDoneApi.as_view()),
    path("<int:pk>/snooze/", CallbackSnoozeApi.as_view()),
]


# Endpoints under /api/reports/… — операторский endpoint для страницы
# «Моя активность». Менеджерский `/operator-activity/` смёржен в
# `/api/analytics/lead-stats/` (см. analytics.apis.LeadStatsApi) —
# по нему больше нет отдельного URL.
reports_urlpatterns = [
    path("my-activity/", MyActivityReportApi.as_view()),
]

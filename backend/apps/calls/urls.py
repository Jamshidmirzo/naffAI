from django.urls import path

from .apis import (
    CallbackDoneApi,
    CallbackMineDueApi,
    CallbackMineListApi,
    CallbackSnoozeApi,
    LeadCallAttemptCreateApi,
    LeadCallbackCreateApi,
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

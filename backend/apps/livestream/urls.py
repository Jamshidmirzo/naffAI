from django.urls import path

from . import apis

urlpatterns = [
    path("room-token/", apis.RoomTokenApi.as_view(), name="live-room-token"),
    path("live-now/", apis.LiveNowApi.as_view(), name="live-now"),
    path("recordings/", apis.RecordingListApi.as_view(), name="live-recordings"),
    path(
        "recordings/<int:pk>/url/",
        apis.RecordingUrlApi.as_view(),
        name="live-recording-url",
    ),
    path(
        "webhooks/livekit/",
        apis.LiveKitWebhookApi.as_view(),
        name="livekit-webhook",
    ),
]

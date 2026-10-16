from django.urls import path

from . import apis

urlpatterns = [
    path("room-token/", apis.RoomTokenApi.as_view(), name="live-room-token"),
    path("live-now/", apis.LiveNowApi.as_view(), name="live-now"),
    path("global-status/", apis.GlobalStatusApi.as_view(), name="live-global-status"),
    path("config/", apis.LiveConfigApi.as_view(), name="live-config"),
    path("recordings/", apis.RecordingListApi.as_view(), name="live-recordings"),
    path(
        "recordings/<int:pk>/url/",
        apis.RecordingUrlApi.as_view(),
        name="live-recording-url",
    ),
    path("snapshots/", apis.SnapshotCreateApi.as_view(), name="live-snapshot-create"),
    path("snapshots/<uuid:pk>/", apis.SnapshotDetailApi.as_view(), name="live-snapshot-detail"),
    path("snapshots/<uuid:pk>/image/", apis.SnapshotImageApi.as_view(), name="live-snapshot-image"),
    path("snapshots/<uuid:pk>/upload/", apis.SnapshotUploadApi.as_view(), name="live-snapshot-upload"),
    path(
        "webhooks/livekit/",
        apis.LiveKitWebhookApi.as_view(),
        name="livekit-webhook",
    ),
]

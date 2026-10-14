from django.urls import path

from . import apis
from .sse import notification_stream_view

urlpatterns = [
    path("", apis.NotificationListApi.as_view(), name="notification-list"),
    path("unread-count/", apis.NotificationUnreadCountApi.as_view(), name="notification-unread-count"),
    path("mark-read/", apis.NotificationMarkReadApi.as_view(), name="notification-mark-read"),
    path("mark-all-read/", apis.NotificationMarkAllReadApi.as_view(), name="notification-mark-all-read"),
    # Server-Sent Events — async StreamingHttpResponse. Нужен uvicorn
    # worker (gunicorn -k uvicorn.workers.UvicornWorker) + отключённая
    # буферизация в nginx для этого location.
    path("stream/", notification_stream_view, name="notification-stream"),
]

from django.urls import path

from . import apis

urlpatterns = [
    path("", apis.NotificationListApi.as_view(), name="notification-list"),
    path("unread-count/", apis.NotificationUnreadCountApi.as_view(), name="notification-unread-count"),
    path("mark-read/", apis.NotificationMarkReadApi.as_view(), name="notification-mark-read"),
    path("mark-all-read/", apis.NotificationMarkAllReadApi.as_view(), name="notification-mark-all-read"),
]

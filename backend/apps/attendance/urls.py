from django.urls import path
from .apis import (
    ScanAttendanceApi,
    MeCurrentAttendanceApi,
    MeHistoryAttendanceApi,
    MeQrAttendanceApi,
    MeToggleAttendanceApi,
    ReportAttendanceApi,
    OperatorLogsAttendanceApi,
    OperatorQrAttendanceApi,
    OperatorQrRotateAttendanceApi,
    OperatorQrPngAttendanceApi,
    SettingsAttendanceApi,
    ManualCloseAttendanceApi,
)

urlpatterns = [
    path("scan/", ScanAttendanceApi.as_view(), name="attendance-scan"),
    path("me/current/", MeCurrentAttendanceApi.as_view(), name="attendance-me-current"),
    path("me/toggle/", MeToggleAttendanceApi.as_view(), name="attendance-me-toggle"),
    path("me/history/", MeHistoryAttendanceApi.as_view(), name="attendance-me-history"),
    path("report/", ReportAttendanceApi.as_view(), name="attendance-report"),
    path("today/", ReportAttendanceApi.as_view(), name="attendance-today"),
    path(
        "operators/<int:operator_id>/logs/",
        OperatorLogsAttendanceApi.as_view(),
        name="attendance-operator-logs",
    ),
    path(
        "operators/<int:operator_id>/qr/",
        OperatorQrAttendanceApi.as_view(),
        name="attendance-operator-qr",
    ),
    path(
        "operators/<int:operator_id>/qr/rotate/",
        OperatorQrRotateAttendanceApi.as_view(),
        name="attendance-operator-qr-rotate",
    ),
    path(
        "operators/<int:operator_id>/qr.png",
        OperatorQrPngAttendanceApi.as_view(),
        name="attendance-operator-qr-png",
    ),
    path("settings/", SettingsAttendanceApi.as_view(), name="attendance-settings"),
    path("logs/<int:log_id>/close/", ManualCloseAttendanceApi.as_view(), name="attendance-manual-close"),
]

# Profile-nested URL mounted under `/api/me/`
me_urlpatterns = [
    path("attendance-qr.png", MeQrAttendanceApi.as_view(), name="me-attendance-qr-png"),
]

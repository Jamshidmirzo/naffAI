from django.urls import path
from .apis import (
    ScanAttendanceApi,
    ScanWithPhotoAttendanceApi,
    QrPreviewAttendanceApi,
    MeCurrentAttendanceApi,
    MeHistoryAttendanceApi,
    MeQrAttendanceApi,
    MeQrTokenAttendanceApi,
    MeToggleAttendanceApi,
    PhotosGalleryAttendanceApi,
    ReportAttendanceApi,
    OperatorLogsAttendanceApi,
    OperatorQrAttendanceApi,
    OperatorQrRotateAttendanceApi,
    OperatorQrPngAttendanceApi,
    OperatorQrTokenAttendanceApi,
    SettingsAttendanceApi,
    ManualCloseAttendanceApi,
)
from .pin_apis import (
    PinStatusApi,
    PinSetApi,
    PinVerifyApi,
    PinResetApi,
)

urlpatterns = [
    path("scan/", ScanAttendanceApi.as_view(), name="attendance-scan"),
    path("qr-preview/", QrPreviewAttendanceApi.as_view(), name="attendance-qr-preview"),
    path("me/scan-with-photo/", ScanWithPhotoAttendanceApi.as_view(), name="attendance-scan-with-photo"),
    path("me/current/", MeCurrentAttendanceApi.as_view(), name="attendance-me-current"),
    path("me/toggle/", MeToggleAttendanceApi.as_view(), name="attendance-me-toggle"),
    path("me/history/", MeHistoryAttendanceApi.as_view(), name="attendance-me-history"),
    path("me/qr-token/", MeQrTokenAttendanceApi.as_view(), name="attendance-me-qr-token"),
    path("report/", ReportAttendanceApi.as_view(), name="attendance-report"),
    path("today/", ReportAttendanceApi.as_view(), name="attendance-today"),
    path("photos/", PhotosGalleryAttendanceApi.as_view(), name="attendance-photos"),
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
    path(
        "operators/<int:operator_id>/qr-token/",
        OperatorQrTokenAttendanceApi.as_view(),
        name="attendance-operator-qr-token",
    ),
    path("settings/", SettingsAttendanceApi.as_view(), name="attendance-settings"),
    path("logs/<int:log_id>/close/", ManualCloseAttendanceApi.as_view(), name="attendance-manual-close"),
    # PIN-gate — статус / установка / подтверждение / сброс.
    # PIN глобальный (один на всех менеджеров), set/reset — только
    # superadmin. См. `apps.attendance.pin_services`.
    path("pin/status/", PinStatusApi.as_view(), name="attendance-pin-status"),
    path("pin/set/", PinSetApi.as_view(), name="attendance-pin-set"),
    path("pin/verify/", PinVerifyApi.as_view(), name="attendance-pin-verify"),
    path("pin/reset/", PinResetApi.as_view(), name="attendance-pin-reset"),
]

# Profile-nested URL mounted under `/api/me/`
me_urlpatterns = [
    path("attendance-qr.png", MeQrAttendanceApi.as_view(), name="me-attendance-qr-png"),
]

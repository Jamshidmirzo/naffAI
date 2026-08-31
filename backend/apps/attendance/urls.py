from django.urls import path
from .apis import (
    DashboardSnapshotAttendanceApi,
    ScanAttendanceApi,
    ScanWithPhotoAttendanceApi,
    QrPreviewAttendanceApi,
    MeBackfillCheckoutAttendanceApi,
    MeCurrentAttendanceApi,
    MeHistoryAttendanceApi,
    MeQrAttendanceApi,
    MeQrTokenAttendanceApi,
    MeToggleAttendanceApi,
    MyPayrollAttendanceApi,
    PayrollListAttendanceApi,
    PayrollDetailAttendanceApi,
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
    # Enforcement wave 2026-08-26 — backfill забытого ухода вчера.
    path(
        "me/backfill-checkout/",
        MeBackfillCheckoutAttendanceApi.as_view(),
        name="attendance-me-backfill-checkout",
    ),
    path("report/", ReportAttendanceApi.as_view(), name="attendance-report"),
    path("today/", ReportAttendanceApi.as_view(), name="attendance-today"),
    # Открытый (без PIN) сводный срез — только счётчики, для дашборда.
    path("dashboard-snapshot/", DashboardSnapshotAttendanceApi.as_view(), name="attendance-dashboard-snapshot"),
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
    # 2026-08-31: attendance-based зарплата.
    path("payroll/", PayrollListAttendanceApi.as_view(), name="attendance-payroll-list"),
    path(
        "payroll/<int:operator_id>/",
        PayrollDetailAttendanceApi.as_view(),
        name="attendance-payroll-detail",
    ),
    path(
        "my-payroll/",
        MyPayrollAttendanceApi.as_view(),
        name="attendance-my-payroll",
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

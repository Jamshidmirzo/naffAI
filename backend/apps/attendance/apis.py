import datetime as dt
from django.http import HttpResponse
from django.shortcuts import get_object_or_404
from django.utils import timezone
from rest_framework import status
from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.throttling import AnonRateThrottle
from django.core.exceptions import ValidationError

from apps.operators.models import Operator
from apps.users.permissions import _role, IsTeamLead, IsAuthenticatedAnyRole
from apps.users.models import Role
from apps.common.pagination import DefaultPagination

from .models import AttendanceLog, AttendanceSettings
from .services import (
    attendance_scan,
    process_attendance_event,
    operator_qr_rotate,
    ScanRateLimitError,
    QrRevokedError,
    IpNotAllowedError,
    attendance_log_manual_close,
)
from .selectors import (
    attendance_settings_get,
    attendance_report,
    logs_for_operator,
    open_log_for_operator,
    operator_qr_png_bytes,
    operator_qr_current,
)
from .permissions import IsTeamLeadOrManager


class AttendanceScanThrottle(AnonRateThrottle):
    scope = "attendance_scan_ip"


def _get_client_ip(request) -> str:
    x_forwarded_for = request.META.get("HTTP_X_FORWARDED_FOR")
    if x_forwarded_for:
        ip = x_forwarded_for.split(",")[0].strip()
    else:
        ip = request.META.get("REMOTE_ADDR")
    return ip


class ScanAttendanceApi(APIView):
    permission_classes = [AllowAny]
    throttle_classes = [AttendanceScanThrottle]

    def post(self, request):
        qr_payload = request.data.get("qr_payload")
        if not qr_payload:
            return Response(
                {"error": "qr_payload is required"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        ip = _get_client_ip(request)
        user_agent = request.META.get("HTTP_USER_AGENT", "")[:256]

        try:
            res = attendance_scan(
                qr_raw=qr_payload,
                ip=ip,
                user_agent=user_agent,
            )
            return Response(res, status=status.HTTP_200_OK)
        except ScanRateLimitError as exc:
            return Response({"error": str(exc)}, status=status.HTTP_429_TOO_MANY_REQUESTS)
        except QrRevokedError as exc:
            return Response({"error": str(exc)}, status=status.HTTP_410_GONE)
        except IpNotAllowedError as exc:
            return Response({"error": str(exc)}, status=status.HTTP_403_FORBIDDEN)
        except ValidationError as exc:
            return Response({"error": str(exc)}, status=status.HTTP_400_BAD_REQUEST)


class MeToggleAttendanceApi(APIView):
    """
    Auth-based check-in/out for the /profile card. No QR needed —
    identifies the operator from request.user.profile.operator and
    delegates to the same process_attendance_event that the QR flow
    uses, so cooldowns, notifications and audit all match.
    """

    permission_classes = [IsAuthenticated, IsAuthenticatedAnyRole]

    def post(self, request):
        profile = getattr(request.user, "profile", None)
        if not profile or not profile.operator_id:
            return Response(
                {"error": "No operator linked to this user"},
                status=status.HTTP_400_BAD_REQUEST,
            )
        ip = _get_client_ip(request)
        ua = request.META.get("HTTP_USER_AGENT", "")[:256]
        try:
            res = process_attendance_event(
                operator=profile.operator,
                source="manual",
                initiator=f"profile:{request.user.username}",
                ip=ip,
                user_agent=ua,
                issue_token=False,
            )
            return Response(res, status=status.HTTP_200_OK)
        except ScanRateLimitError as exc:
            return Response({"error": str(exc)}, status=status.HTTP_429_TOO_MANY_REQUESTS)
        except ValidationError as exc:
            return Response({"error": str(exc)}, status=status.HTTP_400_BAD_REQUEST)


class MeCurrentAttendanceApi(APIView):
    permission_classes = [IsAuthenticated, IsAuthenticatedAnyRole]

    def get(self, request):
        profile = getattr(request.user, "profile", None)
        if not profile or not profile.operator_id:
            return Response(
                {"open_log": None, "today_events": []},
                status=status.HTTP_200_OK,
            )

        operator = profile.operator
        open_log = open_log_for_operator(operator)

        # Today's events (Tashkent calendar day)
        today = timezone.localdate()
        logs_today = logs_for_operator(operator, since=today, until=today)

        today_events = []
        for l in logs_today:
            today_events.append({
                "id": l.id,
                "checked_in_at": l.checked_in_at.isoformat(),
                "checked_out_at": l.checked_out_at.isoformat() if l.checked_out_at else None,
                "was_late": l.was_late,
                "auto_closed": l.auto_closed,
            })

        open_log_data = None
        if open_log:
            open_log_data = {
                "id": open_log.id,
                "checked_in_at": open_log.checked_in_at.isoformat(),
                "was_late": open_log.was_late,
            }

        return Response(
            {"open_log": open_log_data, "today_events": today_events},
            status=status.HTTP_200_OK,
        )


class MeHistoryAttendanceApi(APIView):
    permission_classes = [IsAuthenticated, IsAuthenticatedAnyRole]

    def get(self, request):
        profile = getattr(request.user, "profile", None)
        if not profile or not profile.operator_id:
            return Response({"error": "No operator profile link"}, status=status.HTTP_400_BAD_REQUEST)

        # parse from/to
        from_str = request.query_params.get("from")
        to_str = request.query_params.get("to")

        today = timezone.localdate()
        since = (
            dt.datetime.strptime(from_str, "%Y-%m-%d").date()
            if from_str
            else today - dt.timedelta(days=30)
        )
        until = dt.datetime.strptime(to_str, "%Y-%m-%d").date() if to_str else today

        logs = logs_for_operator(profile.operator, since=since, until=until)

        paginator = DefaultPagination()
        paginated_logs = paginator.paginate_queryset(logs, request)

        data = []
        for l in paginated_logs:
            data.append({
                "id": l.id,
                "checked_in_at": l.checked_in_at.isoformat(),
                "checked_out_at": l.checked_out_at.isoformat() if l.checked_out_at else None,
                "was_late": l.was_late,
                "auto_closed": l.auto_closed,
                "manually_closed": l.manually_closed,
                "manually_closed_by_name": l.manually_closed_by.username
                if l.manually_closed_by
                else None,
                "manual_close_note": l.manual_close_note,
                "duration_min": l.duration_seconds // 60 if l.duration_seconds is not None else None,
                "source": l.source,
            })

        return paginator.get_paginated_response(data)


class MeQrAttendanceApi(APIView):
    permission_classes = [IsAuthenticated, IsAuthenticatedAnyRole]

    def get(self, request):
        profile = getattr(request.user, "profile", None)
        if not profile or not profile.operator_id:
            return Response(
                {"error": "Пользователь не привязан к оператору"},
                status=status.HTTP_404_NOT_FOUND,
            )

        png_bytes = operator_qr_png_bytes(profile.operator)
        response = HttpResponse(png_bytes, content_type="image/png")
        response["Cache-Control"] = "private, no-store"
        response["Content-Disposition"] = "inline; filename=qr.png"
        return response


class ReportAttendanceApi(APIView):
    permission_classes = [IsAuthenticated, IsTeamLeadOrManager]

    def get(self, request):
        date_from_str = request.query_params.get("date_from")
        date_to_str = request.query_params.get("date_to")
        operator_id_str = request.query_params.get("operator")
        fmt = request.query_params.get("format", "json")

        if date_from_str and date_to_str:
            try:
                date_from = dt.datetime.strptime(date_from_str, "%Y-%m-%d").date()
                date_to = dt.datetime.strptime(date_to_str, "%Y-%m-%d").date()
            except ValueError:
                return Response(
                    {"error": "Invalid date format, use YYYY-MM-DD"},
                    status=status.HTTP_400_BAD_REQUEST,
                )

            operator_ids = None
            if operator_id_str:
                operator_ids = [int(x) for x in operator_id_str.split(",") if x.strip()]

            from .selectors import attendance_statistics_report

            report = attendance_statistics_report(
                date_from=date_from, date_to=date_to, operator_ids=operator_ids
            )

            if fmt == "xlsx":
                from apps.common.excel import (
                    new_workbook,
                    write_sheet,
                    workbook_response,
                    BORDER,
                    HEADER_FONT,
                    HEADER_FILL,
                )
                from openpyxl.styles import Alignment
                from openpyxl.utils import get_column_letter

                wb = new_workbook()
                headers = [
                    "Оператор",
                    "Присутствовал",
                    "Ожидалось",
                    "Пропустил",
                    "Опоздал",
                    "Среднее опоздание (мин)",
                    "Авто-закрыто",
                    "Ручное закрытие",
                    "Средняя длина смены (мин)",
                    "Итого часов",
                ]
                rows = []
                for row in report["rows"]:
                    rows.append([
                        row["operator_name"],
                        row["days_present"],
                        row["days_expected"],
                        row["days_absent"],
                        row["late_count"],
                        row["avg_late_minutes"],
                        row["auto_closed_count"],
                        row["manually_closed_count"],
                        row["avg_shift_minutes"],
                        row["total_worked_hours"],
                    ])

                write_sheet(wb, title="Attendance", headers=headers, rows=rows)

                ws2 = wb.create_sheet("Heatmap")
                dates = [x["date"] for x in report["rows"][0]["heatmap"]] if report["rows"] else []
                ws2.append(["Оператор"] + dates)

                for cell in ws2[1]:
                    cell.font = HEADER_FONT
                    cell.fill = HEADER_FILL
                    cell.border = BORDER
                    cell.alignment = Alignment(horizontal="center", vertical="center")

                for row in report["rows"]:
                    op_name = row["operator_name"]
                    statuses = [x["status"] for x in row["heatmap"]]
                    ws2.append([op_name] + statuses)

                for col in ws2.columns:
                    max_len = max(len(str(cell.value or "")) for cell in col)
                    col_letter = get_column_letter(col[0].column)
                    ws2.column_dimensions[col_letter].width = min(max_len + 2, 60)

                return workbook_response(wb, f"attendance_{date_from_str}_to_{date_to_str}.xlsx")

            return Response(report, status=status.HTTP_200_OK)

        date_str = request.query_params.get("date")
        if not date_str or date_str == "today":
            day = timezone.localdate()
        else:
            try:
                day = dt.datetime.strptime(date_str, "%Y-%m-%d").date()
            except ValueError:
                return Response(
                    {"error": "Invalid date format, use YYYY-MM-DD"},
                    status=status.HTTP_400_BAD_REQUEST,
                )

        report = attendance_report(day)
        return Response(report, status=status.HTTP_200_OK)



class OperatorLogsAttendanceApi(APIView):
    permission_classes = [IsAuthenticated, IsTeamLeadOrManager]

    def get(self, request, operator_id):
        operator = get_object_or_404(Operator, id=operator_id)

        from_str = request.query_params.get("from")
        to_str = request.query_params.get("to")

        today = timezone.localdate()
        since = (
            dt.datetime.strptime(from_str, "%Y-%m-%d").date()
            if from_str
            else today - dt.timedelta(days=30)
        )
        until = dt.datetime.strptime(to_str, "%Y-%m-%d").date() if to_str else today

        logs = logs_for_operator(operator, since=since, until=until)

        data = []
        for l in logs:
            data.append({
                "id": l.id,
                "checked_in_at": l.checked_in_at.isoformat(),
                "checked_out_at": l.checked_out_at.isoformat() if l.checked_out_at else None,
                "was_late": l.was_late,
                "auto_closed": l.auto_closed,
                "manually_closed": l.manually_closed,
                "manually_closed_by_name": l.manually_closed_by.username
                if l.manually_closed_by
                else None,
                "manual_close_note": l.manual_close_note,
                "duration_min": l.duration_seconds // 60 if l.duration_seconds is not None else None,
                "source": l.source,
            })

        return Response(data, status=status.HTTP_200_OK)


class OperatorQrAttendanceApi(APIView):
    permission_classes = [IsAuthenticated, IsTeamLeadOrManager]

    def get(self, request, operator_id):
        operator = get_object_or_404(Operator, id=operator_id)
        qr = operator_qr_current(operator)

        if not qr:
            return Response(
                {"nonce": None, "created_at": None, "revoked_at": None},
                status=status.HTTP_200_OK,
            )

        return Response(
            {
                "nonce": qr.nonce[:6] + "...",
                "created_at": qr.created_at.isoformat(),
                "revoked_at": qr.revoked_at.isoformat() if qr.revoked_at else None,
            },
            status=status.HTTP_200_OK,
        )


class OperatorQrRotateAttendanceApi(APIView):
    permission_classes = [IsAuthenticated, IsTeamLead]

    def post(self, request, operator_id):
        operator = get_object_or_404(Operator, id=operator_id)
        qr = operator_qr_rotate(operator=operator, actor=request.user)

        return Response(
            {
                "nonce": qr.nonce[:6] + "...",
                "created_at": qr.created_at.isoformat(),
                "png_url": f"/api/attendance/operators/{operator.id}/qr.png",
            },
            status=status.HTTP_200_OK,
        )


class OperatorQrPngAttendanceApi(APIView):
    permission_classes = [IsAuthenticated, IsTeamLeadOrManager]

    def get(self, request, operator_id):
        operator = get_object_or_404(Operator, id=operator_id)
        png_bytes = operator_qr_png_bytes(operator)

        response = HttpResponse(png_bytes, content_type="image/png")
        response["Cache-Control"] = "private, no-store"
        response["Content-Disposition"] = f"inline; filename=qr-{operator_id}.png"
        return response


class SettingsAttendanceApi(APIView):
    permission_classes = [IsAuthenticated, IsTeamLead]

    def get(self, request):
        settings_obj = attendance_settings_get()
        return Response({
            "shift_start": settings_obj.shift_start.strftime("%H:%M"),
            "shift_end": settings_obj.shift_end.strftime("%H:%M"),
            "late_threshold_min": settings_obj.late_threshold_min,
            "auto_close_at": settings_obj.auto_close_at.strftime("%H:%M"),
            "tg_checkin_enabled": settings_obj.tg_checkin_enabled,
        })

    def patch(self, request):
        settings_obj = attendance_settings_get()

        shift_start = request.data.get("shift_start")
        shift_end = request.data.get("shift_end")
        late_threshold_min = request.data.get("late_threshold_min")
        auto_close_at = request.data.get("auto_close_at")
        tg_checkin_enabled = request.data.get("tg_checkin_enabled")

        if shift_start:
            settings_obj.shift_start = shift_start
        if shift_end:
            settings_obj.shift_end = shift_end
        if late_threshold_min is not None:
            settings_obj.late_threshold_min = int(late_threshold_min)
        if auto_close_at:
            settings_obj.auto_close_at = auto_close_at
        if tg_checkin_enabled is not None:
            settings_obj.tg_checkin_enabled = bool(tg_checkin_enabled)

        settings_obj.updated_by = request.user
        settings_obj.save()

        return Response({
            "shift_start": settings_obj.shift_start.strftime("%H:%M")
            if isinstance(settings_obj.shift_start, dt.time)
            else settings_obj.shift_start,
            "shift_end": settings_obj.shift_end.strftime("%H:%M")
            if isinstance(settings_obj.shift_end, dt.time)
            else settings_obj.shift_end,
            "late_threshold_min": settings_obj.late_threshold_min,
            "auto_close_at": settings_obj.auto_close_at.strftime("%H:%M")
            if isinstance(settings_obj.auto_close_at, dt.time)
            else settings_obj.auto_close_at,
            "tg_checkin_enabled": settings_obj.tg_checkin_enabled,
        })


class ManualCloseAttendanceApi(APIView):
    permission_classes = [IsAuthenticated, IsTeamLeadOrManager]

    def post(self, request, log_id):
        log = get_object_or_404(AttendanceLog, id=log_id)
        note = request.data.get("note", "").strip()
        if len(note) > 280:
            return Response(
                {"error": "Note is too long (max 280 characters)"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        if log.checked_out_at is not None:
            return Response(
                {"detail": "Лог уже закрыт"},
                status=status.HTTP_409_CONFLICT,
            )

        try:
            log = attendance_log_manual_close(log=log, user=request.user, note=note)
        except ValidationError as exc:
            return Response({"error": str(exc)}, status=status.HTTP_400_BAD_REQUEST)

        return Response(
            {
                "id": log.id,
                "operator_id": log.operator_id,
                "checked_in_at": log.checked_in_at.isoformat(),
                "checked_out_at": log.checked_out_at.isoformat(),
                "was_late": log.was_late,
                "auto_closed": log.auto_closed,
                "manually_closed": log.manually_closed,
                "manually_closed_by": log.manually_closed_by_id,
                "manual_close_note": log.manual_close_note,
                "duration_min": log.duration_seconds // 60
                if log.duration_seconds is not None
                else None,
                "source": log.source,
            },
            status=status.HTTP_200_OK,
        )

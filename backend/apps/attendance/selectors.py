import io
import qrcode
import secrets
import datetime as dt
from django.db import transaction
from django.utils import timezone
from django.db.models import QuerySet

from apps.operators.models import Operator, OperatorStatus
from .models import OperatorQr, AttendanceLog, AttendanceSettings


def open_log_for_operator(operator: Operator) -> AttendanceLog | None:
    return AttendanceLog.objects.filter(
        operator=operator, checked_out_at__isnull=True
    ).first()


def logs_for_operator(operator: Operator, *, since: dt.date, until: dt.date) -> QuerySet:
    # Get datetime bounds in Tashkent timezone
    tz = timezone.get_current_timezone()
    start_dt = tz.localize(dt.datetime.combine(since, dt.time.min))
    end_dt = tz.localize(dt.datetime.combine(until, dt.time.max))

    return AttendanceLog.objects.filter(
        operator=operator,
        checked_in_at__range=(start_dt, end_dt),
    ).order_by("-checked_in_at")


def attendance_settings_get() -> AttendanceSettings:
    obj, _ = AttendanceSettings.objects.get_or_create(pk=1)
    return obj


def operator_qr_current(operator: Operator) -> OperatorQr | None:
    return OperatorQr.objects.filter(operator=operator, revoked_at__isnull=True).first()


@transaction.atomic
def operator_qr_current_or_create(operator: Operator) -> OperatorQr:
    qr = OperatorQr.objects.filter(operator=operator, revoked_at__isnull=True).first()
    if not qr:
        nonce = secrets.token_hex(16)
        qr = OperatorQr.objects.create(operator=operator, nonce=nonce)
    return qr


def operator_qr_png_bytes(operator: Operator) -> bytes:
    qr_obj = operator_qr_current_or_create(operator)
    from .services import qr_token_build

    payload = qr_token_build(operator, qr_obj.nonce)

    # Generate QR Code image bytes
    qr = qrcode.QRCode(version=1, box_size=10, border=4)
    qr.add_data(payload)
    qr.make(fit=True)
    img = qr.make_image(fill_color="black", back_color="white")

    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def attendance_report(day: dt.date) -> dict:
    tz = timezone.get_current_timezone()
    start_dt = dt.datetime.combine(day, dt.time.min, tzinfo=tz)
    end_dt = dt.datetime.combine(day, dt.time.max, tzinfo=tz)

    # All active (non-inactive) operators on this day
    active_operators = Operator.objects.exclude(status=OperatorStatus.INACTIVE)
    total_active_operators = active_operators.count()

    # Logs for this day
    logs = AttendanceLog.objects.filter(checked_in_at__range=(start_dt, end_dt))

    present_logs = []
    late_logs = []
    present_op_ids = set()

    for log in logs:
        present_op_ids.add(log.operator_id)
        log_data = {
            "id": log.id,
            "operator_id": log.operator_id,
            "operator_name": log.operator.full_name,
            "checked_in_at": log.checked_in_at.isoformat(),
            "checked_out_at": log.checked_out_at.isoformat() if log.checked_out_at else None,
            "was_late": log.was_late,
            "duration_min": log.duration_seconds // 60 if log.duration_seconds is not None else None,
            "auto_closed": log.auto_closed,
            "source": log.source,
        }
        present_logs.append(log_data)
        if log.was_late:
            late_logs.append(log_data)

    absent_operators = []
    for op in active_operators:
        if op.id not in present_op_ids:
            absent_operators.append({
                "id": op.id,
                "full_name": op.full_name,
            })

    return {
        "total_active_operators": total_active_operators,
        "present": present_logs,
        "late": late_logs,
        "absent": absent_operators,
        "counts": {
            "present": len(present_logs),
            "late": len(late_logs),
            "absent": len(absent_operators),
        },
    }


def attendance_statistics_report(
    date_from: dt.date, date_to: dt.date, operator_ids: list[int] | None = None
) -> dict:
    tz = timezone.get_current_timezone()
    start_dt = dt.datetime.combine(date_from, dt.time.min, tzinfo=tz)
    end_dt = dt.datetime.combine(date_to, dt.time.max, tzinfo=tz)

    operators = Operator.objects.exclude(status=OperatorStatus.INACTIVE)
    if operator_ids:
        operators = operators.filter(id__in=operator_ids)

    logs = AttendanceLog.objects.filter(
        checked_in_at__range=(start_dt, end_dt)
    ).select_related("operator")

    logs_by_op = {}
    for op in operators:
        logs_by_op[op.id] = []

    for log in logs:
        if log.operator_id in logs_by_op:
            logs_by_op[log.operator_id].append(log)

    total_expected = 0
    curr = date_from
    while curr <= date_to:
        if curr.weekday() != 6:
            total_expected += 1
        curr += dt.timedelta(days=1)

    rows = []
    for op in operators:
        op_logs = logs_by_op[op.id]

        days_present = 0
        late_count = 0
        auto_closed_count = 0
        manually_closed_count = 0
        total_shift_seconds = 0
        late_minutes_list = []

        logs_by_date = {}
        for log in op_logs:
            local_in = timezone.localdate(log.checked_in_at)
            if local_in not in logs_by_date:
                logs_by_date[local_in] = []
            logs_by_date[local_in].append(log)

        heatmap = []
        curr = date_from
        while curr <= date_to:
            day_logs = logs_by_date.get(curr, [])
            is_weekend = curr.weekday() == 6

            if not day_logs:
                status = "weekend" if is_weekend else "absent"
            else:
                days_present += 1
                has_manual = any(l.manually_closed for l in day_logs)
                has_auto = any(l.auto_closed for l in day_logs)
                has_late = any(l.was_late for l in day_logs)

                if has_manual:
                    status = "manually_closed"
                    manually_closed_count += 1
                elif has_auto:
                    status = "auto_closed"
                    auto_closed_count += 1
                elif has_late:
                    status = "late"
                    late_count += 1
                else:
                    status = "on_time"

                for l in day_logs:
                    if l.duration_seconds is not None:
                        total_shift_seconds += l.duration_seconds

                    if l.was_late:
                        settings_obj = attendance_settings_get()
                        shift_start_time = settings_obj.shift_start
                        local_in_dt = timezone.localtime(l.checked_in_at)
                        if isinstance(shift_start_time, str):
                            h, m = map(int, shift_start_time.split(":")[:2])
                        else:
                            h, m = shift_start_time.hour, shift_start_time.minute
                        shift_start_dt = local_in_dt.replace(hour=h, minute=m, second=0, microsecond=0)
                        diff_sec = (local_in_dt - shift_start_dt).total_seconds()
                        diff_min = int(diff_sec / 60)
                        if diff_min > 0:
                            late_minutes_list.append(diff_min)

            heatmap.append({"date": curr.strftime("%Y-%m-%d"), "status": status})
            curr += dt.timedelta(days=1)

        avg_late_minutes = int(sum(late_minutes_list) / len(late_minutes_list)) if late_minutes_list else 0
        avg_shift_minutes = int((total_shift_seconds / 60) / days_present) if days_present > 0 else 0
        total_worked_hours = round(total_shift_seconds / 3600, 1)

        rows.append({
            "operator_id": op.id,
            "operator_name": op.full_name,
            "days_expected": total_expected,
            "days_present": days_present,
            "days_absent": max(total_expected - days_present, 0),
            "late_count": late_count,
            "avg_late_minutes": avg_late_minutes,
            "auto_closed_count": auto_closed_count,
            "manually_closed_count": manually_closed_count,
            "avg_shift_minutes": avg_shift_minutes,
            "total_worked_hours": total_worked_hours,
            "heatmap": heatmap,
        })

    return {
        "period": {"from": date_from.strftime("%Y-%m-%d"), "to": date_to.strftime("%Y-%m-%d")},
        "rows": rows,
    }


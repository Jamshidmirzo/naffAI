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
    # Get datetime bounds in the active (Tashkent) timezone. Django 5 /
    # Python 3.9+ ships zoneinfo which uses `.replace(tzinfo=...)`, not
    # the old pytz `.localize()` API.
    tz = timezone.get_current_timezone()
    start_dt = dt.datetime.combine(since, dt.time.min).replace(tzinfo=tz)
    end_dt = dt.datetime.combine(until, dt.time.max).replace(tzinfo=tz)

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


def _origin_allowed(origin: str) -> bool:
    """Guard against Host-header / origin-hint spoofing.

    Only origins explicitly listed in `QR_CHECKIN_ALLOWED_ORIGINS` are
    trusted as the base for the scannable QR URL. Everything else falls
    back to the statically configured `QR_CHECKIN_URL`.
    """
    from django.conf import settings

    if not origin:
        return False
    allowed = getattr(settings, "QR_CHECKIN_ALLOWED_ORIGINS", []) or []
    return origin.rstrip("/") in {o.rstrip("/") for o in allowed}


def build_scan_url(payload: str, *, request=None, origin_hint: str | None = None) -> str:
    """Wrap the raw HMAC token into a scannable `https://<host>/scan?qr=…`.

    Resolution order (first match wins):
      1. `origin_hint` (typically `window.location.origin` from the SPA)
         — required so that a browser sitting on demo.naff.flek.uz gets a
         QR pointing at demo.naff.flek.uz, even though its API calls hit
         the prod backend directly.
      2. `request.get_host()` scheme+host — works when the SPA and the
         API share the same public domain.
      3. Static `settings.QR_CHECKIN_URL` (deploy-time default).
      4. Raw payload (dev-only fallback so a plain `printenv` still
         encodes something scannable).

    Only origins in `QR_CHECKIN_ALLOWED_ORIGINS` are trusted for steps 1
    and 2 to prevent an attacker from injecting a phishing URL into an
    operator's QR by forging a `Host` header or `?origin=` query param.
    """
    from django.conf import settings
    from urllib.parse import quote

    base = ""

    # 1. explicit origin from the SPA (window.location.origin)
    if origin_hint and _origin_allowed(origin_hint):
        base = f"{origin_hint.rstrip('/')}/scan"

    # 2. host of the current API request (respects USE_X_FORWARDED_HOST)
    if not base and request is not None:
        try:
            scheme = "https" if request.is_secure() else "http"
            host = request.get_host()
            candidate_origin = f"{scheme}://{host}"
            if _origin_allowed(candidate_origin):
                base = request.build_absolute_uri("/scan")
        except Exception:
            base = ""

    # 3. static configured URL
    if not base:
        base = getattr(settings, "QR_CHECKIN_URL", "").rstrip("/")

    if not base:
        # 4. dev fallback — raw token, phone camera won't open it but
        # unit tests / management commands still succeed.
        return payload

    return f"{base.rstrip('/')}?qr={quote(payload, safe='')}"


def operator_qr_png_bytes(operator: Operator, *, request=None, origin_hint: str | None = None) -> bytes:
    qr_obj = operator_qr_current_or_create(operator)
    from .services import qr_token_build

    payload = qr_token_build(operator, qr_obj.nonce)
    content = build_scan_url(payload, request=request, origin_hint=origin_hint)

    # Generate QR Code image bytes
    qr = qrcode.QRCode(version=1, box_size=10, border=4)
    qr.add_data(content)
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
            "checkin_photo_url": log.checkin_photo.url if log.checkin_photo else None,
            "checkout_photo_url": log.checkout_photo.url if log.checkout_photo else None,
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


def attendance_dashboard_snapshot() -> dict:
    """
    Компактный срез посещаемости для менеджерского дашборда «Сводка дня».

    Возвращает ТОЛЬКО счётчики, без имён — этот endpoint открыт всем
    менеджерам (без PIN-гейта), поэтому чувствительные ФИО-ряды туда не
    попадают. Для полной таблицы есть `/api/attendance/report/` под PIN.

    Схема:
      {
        "on_shift":  <int>,   # сколько ЩАС открытых смен (checked_out_at IS NULL)
        "expected":  <int>,   # сколько операторов ожидается сегодня
                              # (все не-inactive; воскресенье → 0)
        "late_today":<int>,   # сколько логов сегодня с was_late=True
      }
    """
    now = timezone.now()
    tz = timezone.get_current_timezone()
    today_local = timezone.localdate(now)
    start_dt = dt.datetime.combine(today_local, dt.time.min).replace(tzinfo=tz)
    end_dt = dt.datetime.combine(today_local, dt.time.max).replace(tzinfo=tz)

    # Открытые смены прямо сейчас — устойчиво к «висящим» логам:
    # берём только те, что открыты сегодня. Ночевать никто не должен —
    # auto_close_at по умолчанию 23:00.
    on_shift = AttendanceLog.objects.filter(
        checked_out_at__isnull=True,
        checked_in_at__gte=start_dt,
    ).count()

    # Ожидаемые сегодня: все активные + trainee операторы. Воскресенье =
    # выходной по правилам магазина → 0.
    if today_local.weekday() == 6:
        expected = 0
    else:
        expected = Operator.objects.exclude(status=OperatorStatus.INACTIVE).count()

    late_today = AttendanceLog.objects.filter(
        checked_in_at__gte=start_dt,
        checked_in_at__lte=end_dt,
        was_late=True,
    ).count()

    return {
        "on_shift": on_shift,
        "expected": expected,
        "late_today": late_today,
    }


def attendance_photos_queryset(
    *,
    date_from: dt.date | None = None,
    date_to: dt.date | None = None,
    operator_id: int | None = None,
) -> QuerySet:
    """
    QuerySet логов с фото (хотя бы одно из checkin_photo / checkout_photo).

    Отфильтровано под галерею супер-админа/менеджера:
      - только логи с непустым `checkin_photo` ИЛИ `checkout_photo`
      - опционально по дате начала смены (Tashkent-календарь)
      - опционально по конкретному оператору
      - сортировка «свежее → старее» по `checked_in_at`
    """
    from django.db.models import Q

    qs = AttendanceLog.objects.select_related("operator").filter(
        ~Q(checkin_photo="") | ~Q(checkout_photo="")
    )

    if date_from is not None or date_to is not None:
        tz = timezone.get_current_timezone()
        if date_from is not None:
            start_dt = dt.datetime.combine(date_from, dt.time.min).replace(tzinfo=tz)
            qs = qs.filter(checked_in_at__gte=start_dt)
        if date_to is not None:
            end_dt = dt.datetime.combine(date_to, dt.time.max).replace(tzinfo=tz)
            qs = qs.filter(checked_in_at__lte=end_dt)

    if operator_id is not None:
        qs = qs.filter(operator_id=operator_id)

    return qs.order_by("-checked_in_at")


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


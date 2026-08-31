import io
import qrcode
import secrets
import datetime as dt
from collections import defaultdict
from decimal import Decimal, ROUND_HALF_UP

from django.db import transaction
from django.utils import timezone
from django.db.models import QuerySet

from apps.operators.models import Operator, OperatorStatus
from .models import OperatorQr, AttendanceLog, AttendanceSettings
from .utils import is_working_day, week_bucket, working_days_in_month


def open_log_for_operator(operator: Operator) -> AttendanceLog | None:
    return AttendanceLog.objects.filter(
        operator=operator, checked_out_at__isnull=True
    ).first()


def pending_backfill_log_for_operator(
    operator: Operator,
    *,
    lookback_days: int = 3,
) -> AttendanceLog | None:
    """
    Самый свежий лог оператора за последние `lookback_days`, который cron
    закрыл автоматически (`auto_closed=True`) и который оператор ещё не
    подтвердил вручную (`backfilled_by_operator_at IS NULL`).

    Используется на фронте для показа блокирующего модала «во сколько вы
    вчера ушли?» — до тех пор, пока оператор не введёт фактическое время
    ухода (или пока лог не устареет за окном lookback'а).

    Лимит 3 дня выбран прагматично: если оператор был в отпуске и вернулся
    через неделю, старый auto_closed лог не должен внезапно всплыть на
    экране (backfill за такую даль всё равно теряет смысл).
    """
    threshold = timezone.now() - dt.timedelta(days=lookback_days)
    return (
        AttendanceLog.objects.filter(
            operator=operator,
            auto_closed=True,
            backfilled_by_operator_at__isnull=True,
            checked_in_at__gte=threshold,
        )
        .order_by("-checked_in_at")
        .first()
    )


def forgotten_checkouts_count(operator: Operator, *, days: int = 30) -> int:
    """
    Сколько раз оператор «забыл выйти» за последние `days` дней:
    логи, которые cron auto-close'нул И оператор так и не ввёл
    фактическое время ухода задним числом.

    Rolling window (по умолчанию 30 дней) — счётчик естественно
    «сбрасывается» со временем: старые нарушения выпадают. Порог для
    менеджерского алерта — 5 (см. UI-бейдж).
    """
    threshold = timezone.now() - dt.timedelta(days=days)
    return AttendanceLog.objects.filter(
        operator=operator,
        auto_closed=True,
        backfilled_by_operator_at__isnull=True,
        checked_in_at__gte=threshold,
    ).count()


def forgotten_checkouts_bulk(
    operator_ids: list[int], *, days: int = 30
) -> dict[int, int]:
    """
    Пакетный вариант `forgotten_checkouts_count` для списка операторов
    (менеджерская страница `/operators/`). Один GROUP BY вместо N запросов.
    """
    from django.db.models import Count

    if not operator_ids:
        return {}
    threshold = timezone.now() - dt.timedelta(days=days)
    rows = (
        AttendanceLog.objects.filter(
            operator_id__in=operator_ids,
            auto_closed=True,
            backfilled_by_operator_at__isnull=True,
            checked_in_at__gte=threshold,
        )
        .values("operator_id")
        .annotate(n=Count("id"))
    )
    counts = {op_id: 0 for op_id in operator_ids}
    for row in rows:
        counts[row["operator_id"]] = row["n"]
    return counts


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


def attendance_payroll_summary(
    operator: Operator, year: int, month: int
) -> dict:
    """
    Полная attendance-based зарплатная сводка за календарный месяц.

    Порядок расчёта:
      1. `resolve_operator_config` — оклад, персональные часы, grace,
         штраф, выходной, гейт, лимит free-absences.
      2. Список рабочих дней месяца (без личного выходного).
      3. Загружаем `AttendanceLog` за месяц одним запросом, группируем
         по локальной дате первого check-in оператора.
      4. Для каждого рабочего дня:
         - если есть лог → сравниваем локальное время `checked_in_at`
           с `shift_start + grace_period_min`. `minutes_late > 0` →
           статус `late` + штраф. Иначе `on_time`.
         - если нет лога → `absent`. Считаем, сколько уже было absent-ов
           в ISO-неделе этого дня (по правилу «weekly_free_absences в
           неделю прощаются»). Если ниже лимита → `free_absence` без
           вычета. Иначе → `billable_absent` + −дневная ставка.
      5. `daily_rate = salary_uzs / len(working_days_planned)` —
         округляем HALF_UP до 1 сум (UZS не использует копейки).
      6. `attendance_rate = days_attended / working_days_planned`.
         Если ниже гейта → `gate_triggered=True, salary_earned=0`.
         Иначе `salary_earned = salary_uzs − absence_deduction −
         late_penalty_total`.

    Возвращает JSON-friendly dict — прямо отдаётся API endpoint'ам и
    Excel/PDF-экспортом. Не мутирует БД.
    """
    from .services import _time_to_time, resolve_operator_config

    cfg = resolve_operator_config(operator)
    weekly_day_off = cfg["weekly_day_off"]
    salary_gross = Decimal(cfg["salary_uzs"]).quantize(Decimal("1"))
    grace = int(cfg["grace_period_min"])
    late_penalty = Decimal(cfg["late_penalty_uzs"]).quantize(Decimal("1"))
    weekly_free = int(cfg["weekly_free_absences"])
    gate_pct = int(cfg["attendance_gate_pct"])
    shift_start_t = _time_to_time(cfg["shift_start"])
    shift_end_t = _time_to_time(cfg["shift_end"])

    working_days = working_days_in_month(int(year), int(month), weekly_day_off)
    working_days_planned = len(working_days)

    # Daily rate — округляем к 1 сум (UZS): менеджер не любит копейки.
    if working_days_planned > 0:
        daily_rate = (salary_gross / Decimal(working_days_planned)).quantize(
            Decimal("1"), rounding=ROUND_HALF_UP
        )
    else:
        # Странный месяц (все дни — выходные оператора). Не должен
        # случиться на реальных weekly_day_off ∈ {0..6}, но на всякий
        # случай не делим на ноль.
        daily_rate = Decimal("0")

    # Все логи оператора за месяц — одним запросом. Границы месяца
    # переводим в UTC-диапазон через локальный timezone.
    tz = timezone.get_current_timezone()
    period_start = dt.datetime.combine(
        dt.date(int(year), int(month), 1), dt.time.min
    ).replace(tzinfo=tz)
    # Первый день следующего месяца — граница исключительно.
    if int(month) == 12:
        next_period = dt.date(int(year) + 1, 1, 1)
    else:
        next_period = dt.date(int(year), int(month) + 1, 1)
    period_end = dt.datetime.combine(next_period, dt.time.min).replace(tzinfo=tz)

    logs_qs = AttendanceLog.objects.filter(
        operator=operator,
        checked_in_at__gte=period_start,
        checked_in_at__lt=period_end,
    ).order_by("checked_in_at")

    # Группируем логи по локальной дате check-in. Если оператор в один
    # день сделал несколько check-in/out (редко), берём самый ранний —
    # он определяет late-статус, а суммарная длительность нам тут не
    # важна для payroll'a (это attendance-selector отдельный).
    logs_by_date: dict[dt.date, list[AttendanceLog]] = defaultdict(list)
    for log in logs_qs:
        local_in = timezone.localtime(log.checked_in_at)
        logs_by_date[local_in.date()].append(log)

    # Идём по всем дням месяца, чтобы включить и выходные (для frontend'a).
    _, last_day = _month_last_day(int(year), int(month))
    all_days: list[dt.date] = [
        dt.date(int(year), int(month), d) for d in range(1, last_day + 1)
    ]

    days_out: list[dict] = []
    days_attended = 0
    days_absent = 0
    days_late = 0
    late_minutes_sum = 0
    weekly_free_used: dict[tuple[int, int], int] = defaultdict(int)
    absence_deduction = Decimal("0")
    late_penalty_total = Decimal("0")
    weekly_free_absences_used_total = 0
    billable_absences = 0

    for day in all_days:
        weekday = day.weekday()
        is_working = weekday != weekly_day_off

        if not is_working:
            days_out.append(
                {
                    "date": day.isoformat(),
                    "weekday": weekday,
                    "is_working_day": False,
                    "checked_in_at": None,
                    "checked_out_at": None,
                    "status": "weekend",
                    "minutes_late": 0,
                    "deduction_uzs": "0",
                    "note": "Личный выходной",
                }
            )
            continue

        day_logs = logs_by_date.get(day, [])
        if day_logs:
            days_attended += 1
            log = day_logs[0]  # earliest
            local_in = timezone.localtime(log.checked_in_at)
            # Late detection в локальной таймзоне: диff между
            # `checked_in_at` и `shift_start + grace`.
            shift_start_dt = local_in.replace(
                hour=shift_start_t.hour,
                minute=shift_start_t.minute,
                second=0,
                microsecond=0,
            )
            late_cutoff = shift_start_dt + dt.timedelta(minutes=grace)
            if local_in > late_cutoff:
                minutes_late = int((local_in - late_cutoff).total_seconds() / 60)
                # Если оператор пришёл в grace-минуту ровно —
                # `local_in > late_cutoff` False → on_time. Если хоть
                # секунда сверх — late. Считаем ЦЕЛЫЕ минуты сверх grace.
                if minutes_late == 0:
                    minutes_late = 1  # человек опоздал <1мин над grace → 1мин штрафа
                days_late += 1
                late_minutes_sum += minutes_late
                late_penalty_total += late_penalty
                status = "late"
                deduction = late_penalty
                note = f"Опоздание на {minutes_late} мин (сверх grace {grace} мин)"
            else:
                status = "on_time"
                minutes_late = 0
                deduction = Decimal("0")
                note = ""
            days_out.append(
                {
                    "date": day.isoformat(),
                    "weekday": weekday,
                    "is_working_day": True,
                    "checked_in_at": log.checked_in_at.isoformat(),
                    "checked_out_at": (
                        log.checked_out_at.isoformat() if log.checked_out_at else None
                    ),
                    "status": status,
                    "minutes_late": minutes_late,
                    "deduction_uzs": str(deduction.quantize(Decimal("1"))),
                    "note": note,
                }
            )
        else:
            days_absent += 1
            wk = week_bucket(day)
            used = weekly_free_used[wk]
            if used < weekly_free:
                weekly_free_used[wk] += 1
                weekly_free_absences_used_total += 1
                status = "free_absence"
                deduction = Decimal("0")
                note = (
                    f"Прощённый пропуск ({used + 1}/{weekly_free} в неделе)"
                )
            else:
                billable_absences += 1
                absence_deduction += daily_rate
                status = "absent"
                deduction = daily_rate
                note = "Вычет: дневная ставка"
            days_out.append(
                {
                    "date": day.isoformat(),
                    "weekday": weekday,
                    "is_working_day": True,
                    "checked_in_at": None,
                    "checked_out_at": None,
                    "status": status,
                    "minutes_late": 0,
                    "deduction_uzs": str(deduction.quantize(Decimal("1"))),
                    "note": note,
                }
            )

    attendance_rate_pct = (
        (days_attended / working_days_planned * 100.0) if working_days_planned else 0.0
    )
    gate_triggered = attendance_rate_pct < gate_pct
    avg_late_minutes = (
        int(late_minutes_sum / days_late) if days_late else 0
    )

    if gate_triggered:
        salary_earned = Decimal("0")
    else:
        salary_earned = salary_gross - absence_deduction - late_penalty_total
        if salary_earned < 0:
            salary_earned = Decimal("0")

    # Финальные округления. Всё Decimal, никаких float.
    return {
        "operator_id": operator.id,
        "operator_name": operator.full_name,
        "year": int(year),
        "month": int(month),
        "salary_gross": str(salary_gross),
        "shift_start": shift_start_t.strftime("%H:%M"),
        "shift_end": shift_end_t.strftime("%H:%M"),
        "grace_period_min": grace,
        "weekly_day_off": weekly_day_off,
        "weekly_free_absences": weekly_free,
        "working_days_planned": working_days_planned,
        "days_attended": days_attended,
        "days_absent": days_absent,
        "days_late": days_late,
        "avg_late_minutes": avg_late_minutes,
        "attendance_rate_pct": round(attendance_rate_pct, 1),
        "gate_pct": gate_pct,
        "gate_triggered": gate_triggered,
        "weekly_free_absences_used": weekly_free_absences_used_total,
        "billable_absences": billable_absences,
        "daily_rate": str(daily_rate.quantize(Decimal("1"))),
        "absence_deduction": str(absence_deduction.quantize(Decimal("1"))),
        "late_penalty_per_event": str(late_penalty.quantize(Decimal("1"))),
        "late_penalty_total": str(late_penalty_total.quantize(Decimal("1"))),
        "salary_earned": str(salary_earned.quantize(Decimal("1"))),
        "days": days_out,
    }


def _month_last_day(year: int, month: int) -> tuple[int, int]:
    import calendar

    return calendar.monthrange(int(year), int(month))


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


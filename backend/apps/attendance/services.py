import hmac
import hashlib
import secrets
import ipaddress
import datetime as dt
from decimal import Decimal
from io import BytesIO
from django.conf import settings
from django.core.exceptions import ValidationError, PermissionDenied
from django.core.exceptions import ImproperlyConfigured
from django.utils import timezone
from django.contrib.auth import get_user_model
from rest_framework.authtoken.models import Token
from django.db import transaction

from django.core.files.base import ContentFile

from apps.operators.models import Operator
from apps.users.models import Profile
from apps.audit.services import audit_log_create
from .models import OperatorQr, AttendanceLog, AttendanceSettings
from .selectors import open_log_for_operator, attendance_settings_get
from . import face as _face
from .face import PhotoValidationError, validate_and_hash_photo

User = get_user_model()


class QrRevokedError(PermissionDenied):
    pass


class ScanRateLimitError(ValidationError):
    pass


class IpNotAllowedError(PermissionDenied):
    pass


class TgCheckinDisabledError(ValidationError):
    pass


class PhotoRequiredError(ValidationError):
    pass


def _notify_managers_attendance(
    *, operator: Operator, action: str, was_late: bool = False, duration_min: int = 0
) -> None:
    """
    Fan out a bell-notification to every manager profile so the check-in
    or check-out shows up in the notifications menu of the CRM in real
    time. Fire-and-forget: swallows any error to never break the scan
    transaction.
    """
    try:
        from apps.notifications.models import Notification, NotificationKind
        from apps.users.models import Role

        managers = User.objects.filter(
            profile__role__in=(Role.MANAGER, Role.TEAM_LEAD, Role.SUPERADMIN),
            is_active=True,
        )
        if not managers.exists():
            return
        if action == "check_in":
            title = f"🟢 {operator.full_name} — приход"
            body = "⚠ опоздание" if was_late else ""
        else:
            hrs = round(duration_min / 60, 1) if duration_min else 0
            title = f"🔴 {operator.full_name} — уход"
            body = f"смена {hrs} ч" if hrs else ""
        Notification.objects.bulk_create(
            [
                Notification(
                    recipient=m,
                    kind=NotificationKind.SYSTEM,
                    title=title,
                    body=body,
                    link=f"/operators/{operator.id}",
                    metadata={
                        "kind": "attendance",
                        "action": action,
                        "operator_id": operator.id,
                        "was_late": was_late,
                        "duration_min": duration_min,
                    },
                )
                for m in managers
            ]
        )
    except Exception:
        import logging

        logging.getLogger("attendance").warning(
            "manager notify failed op=%s action=%s", operator.id, action, exc_info=True
        )


def _ip_allowed(ip: str | None) -> bool:
    networks = getattr(settings, "ATTENDANCE_ALLOWED_NETWORKS", [])
    if not networks:
        return True
    if not ip:
        return False
    try:
        ip_addr = ipaddress.ip_address(ip)
        for net_str in networks:
            if ip_addr in ipaddress.ip_network(net_str):
                return True
    except Exception:
        return False
    return False


def _get_hmac_key() -> bytes:
    key = getattr(settings, "QR_ATTENDANCE_HMAC_KEY", "")
    if not key:
        raise ImproperlyConfigured("QR_ATTENDANCE_HMAC_KEY settings is not configured")
    return key.encode()


def qr_token_build(operator: Operator, nonce: str) -> str:
    key = _get_hmac_key()
    msg = f"{operator.id}:{nonce}".encode()
    sig = hmac.new(key, msg, hashlib.sha256).hexdigest()[:16]
    return f"naffai-att-v1:{operator.id}:{nonce}:{sig}"


def qr_token_verify(raw: str) -> tuple[Operator, OperatorQr]:
    parts = raw.split(":")
    if len(parts) != 4 or parts[0] != "naffai-att-v1":
        raise ValidationError("Неверный формат QR-кода")

    op_id_str, nonce, signature = parts[1], parts[2], parts[3]
    try:
        op_id = int(op_id_str)
    except ValueError:
        raise ValidationError("Неверный формат QR-кода")

    try:
        operator = Operator.objects.get(id=op_id)
    except Operator.DoesNotExist:
        raise ValidationError("Неверный формат QR-кода")

    try:
        qr = OperatorQr.objects.get(nonce=nonce)
    except OperatorQr.DoesNotExist:
        raise ValidationError("Неверный формат QR-кода")

    if qr.revoked_at is not None:
        raise QrRevokedError("QR-код отозван, обратитесь к тимлиду")

    key = _get_hmac_key()
    msg = f"{op_id}:{nonce}".encode()
    expected_sig = hmac.new(key, msg, hashlib.sha256).hexdigest()[:16]

    if not hmac.compare_digest(signature, expected_sig):
        raise ValidationError("Неверная подпись QR-кода")

    return operator, qr


@transaction.atomic
def operator_qr_rotate(*, operator: Operator, actor) -> OperatorQr:
    # Revoke current active QR
    OperatorQr.objects.filter(operator=operator, revoked_at__isnull=True).update(
        revoked_at=timezone.now(), revoked_by=actor
    )
    # Create new QR
    nonce = secrets.token_hex(16)
    qr = OperatorQr.objects.create(operator=operator, nonce=nonce)

    audit_log_create(
        user=actor,
        action="attendance.qr_rotate",
        entity="OperatorQr",
        entity_id=operator.id,
        changes={"operator_id": operator.id},
    )
    return qr


@transaction.atomic
def attendance_scan(
    *,
    qr_raw: str,
    ip: str | None,
    user_agent: str,
    photo_bytes: bytes | None = None,
    photo_filename: str | None = None,
) -> dict:
    if not _ip_allowed(ip):
        audit_log_create(
            user=None,
            action="attendance.scan_fail",
            entity="AttendanceLog",
            entity_id=0,
            changes={
                "error_code": "ip_not_allowed",
                "ip": ip,
                "source": "qr",
            },
        )
        raise IpNotAllowedError("Сканирование недоступно с этого IP")

    try:
        operator, qr = qr_token_verify(qr_raw)
    except QrRevokedError as exc:
        audit_log_create(
            user=None,
            action="attendance.scan_fail",
            entity="AttendanceLog",
            entity_id=0,
            changes={
                "error_code": "qr_revoked",
                "source": "qr",
            },
        )
        raise exc
    except ValidationError as exc:
        audit_log_create(
            user=None,
            action="attendance.scan_fail",
            entity="AttendanceLog",
            entity_id=0,
            changes={
                "error_code": "bad_qr",
                "source": "qr",
            },
        )
        raise exc

    return process_attendance_event(
        operator=operator,
        source="qr",
        initiator=f"ip={ip or '-'}",
        ip=ip,
        user_agent=user_agent,
        issue_token=True,
        photo_bytes=photo_bytes,
        photo_filename=photo_filename,
    )


@transaction.atomic
def process_attendance_event(
    *,
    operator: Operator,
    source: str,
    initiator: str,
    ip: str | None = None,
    user_agent: str = "",
    issue_token: bool = False,
    photo_bytes: bytes | None = None,
    photo_filename: str | None = None,
    require_photo_override: bool | None = None,
) -> dict:
    """
    Photo semantics:
    - `photo_bytes` is optional. If provided → always validated (face +
       phash + dup) and stored on the created / closed AttendanceLog.
    - `require_photo_override` — if True, forces the "photo required" gate
       even when AttendanceSettings.require_photo is False. Used by
       `/attendance/me/scan-with-photo/` and Telegram `/checkin` where the
       photo flow is mandatory by contract.
    - If settings.require_photo (or override) is True and no photo →
       PhotoRequiredError. Otherwise no photo is fine (back-compat).
    """
    settings_obj = attendance_settings_get()

    photo_required = settings_obj.require_photo or bool(require_photo_override)
    if photo_required and not photo_bytes:
        audit_log_create(
            user=None,
            action="attendance.scan_fail",
            entity="AttendanceLog",
            entity_id=operator.id,
            changes={
                "error_code": "photo_required",
                "source": source,
                "initiator": initiator,
            },
        )
        raise PhotoRequiredError("Требуется фото для отметки")

    photo_phash = ""
    if photo_bytes:
        # ---- Double-submit idempotency guard --------------------------------
        # If the frontend re-sends the *same photo* within 30s (network
        # hiccup, user rage-taps «Отправить», iOS Safari retrying an
        # aborted request) we don't want the second call to hit
        # `is_photo_recent_duplicate` and get slapped with 400 — the
        # first call already succeeded. Instead, look up the log that
        # was created by the first request and replay its response.
        #
        # Uses `_face.perceptual_hash` (module attr, not direct import)
        # so tests that monkey-patch `face.perceptual_hash` see the
        # patch through this call site.
        preliminary_phash = _face.perceptual_hash(photo_bytes)
        if preliminary_phash:
            replay_log = _face.find_recent_matching_log(
                operator=operator, phash=preliminary_phash, seconds=30
            )
            if replay_log is not None:
                return _replay_attendance_response(replay_log, source=source)

        try:
            photo_phash = validate_and_hash_photo(
                operator=operator,
                image_bytes=photo_bytes,
                require_face=settings_obj.require_face,
                max_size_mb=settings_obj.photo_max_size_mb,
                precomputed_phash=preliminary_phash,
            )
        except PhotoValidationError as exc:
            audit_log_create(
                user=None,
                action="attendance.scan_fail",
                entity="AttendanceLog",
                entity_id=operator.id,
                changes={
                    "error_code": exc.code,
                    "source": source,
                    "initiator": initiator,
                },
            )
            raise ValidationError(str(exc)) from exc

    if source == "tg" and not settings_obj.tg_checkin_enabled:
        audit_log_create(
            user=None,
            action="attendance.scan_fail",
            entity="AttendanceLog",
            entity_id=operator.id,
            changes={
                "error_code": "tg_disabled",
                "source": "tg",
                "initiator": initiator,
            },
        )
        raise TgCheckinDisabledError("Отметка через Telegram отключена. Используйте QR.")

    # Check operator rate-limit / cooldown (30 seconds)
    last_log = (
        AttendanceLog.objects.filter(operator=operator).order_by("-checked_in_at").first()
    )
    if last_log:
        last_time = max(
            last_log.checked_in_at,
            last_log.checked_out_at or last_log.checked_in_at,
        )
        cooldown = getattr(settings, "ATTENDANCE_SCAN_COOLDOWN_SECONDS", 30)
        if (timezone.now() - last_time).total_seconds() < cooldown:
            audit_log_create(
                user=None,
                action="attendance.scan_fail",
                entity="AttendanceLog",
                entity_id=operator.id,
                changes={
                    "error_code": "rate_limited",
                    "operator_id": operator.id,
                    "source": source,
                    "initiator": initiator,
                },
            )
            raise ScanRateLimitError("Подождите 30 секунд.")

    if source == "qr" and ip and user_agent:
        # Auto-close ONLY truly stale sessions of other operators from the
        # same device. Cutoff = 3 hours so an operator whose colleague
        # checks in from the same office WiFi + similar phone doesn't get
        # their fresh session ripped out from under them. Two operators
        # actually sharing one phone within a shift is rare; a forgotten
        # session from the morning is the case this branch exists for.
        stale_cutoff = timezone.now() - dt.timedelta(hours=3)
        stale_logs = AttendanceLog.objects.filter(
            checked_out_at__isnull=True,
            checked_in_ip=ip,
            checked_in_user_agent=user_agent,
            checked_in_at__lt=stale_cutoff,
        ).exclude(operator=operator)
        for stale_log in stale_logs:
            _force_close_stale_log(stale_log, current_ip=ip, current_user_agent=user_agent)

    open_log = open_log_for_operator(operator)
    if not open_log:
        return _attendance_check_in(
            operator=operator,
            source=source,
            initiator=initiator,
            ip=ip,
            user_agent=user_agent,
            issue_token=issue_token,
            settings_obj=settings_obj,
            photo_bytes=photo_bytes,
            photo_filename=photo_filename,
            photo_phash=photo_phash,
        )
    else:
        return _attendance_check_out(
            log=open_log,
            source=source,
            initiator=initiator,
            ip=ip,
            user_agent=user_agent,
            photo_bytes=photo_bytes,
            photo_filename=photo_filename,
            photo_phash=photo_phash,
        )


def _force_close_stale_log(log: AttendanceLog, current_ip: str, current_user_agent: str):
    now = timezone.now()
    log.checked_out_at = now
    log.auto_closed = True
    log.save(update_fields=["checked_out_at", "auto_closed"])

    if log.token_key:
        Token.objects.filter(key=log.token_key).delete()

    audit_log_create(
        user=None,
        action="attendance.stale_session_closed",
        entity="AttendanceLog",
        entity_id=log.id,
        changes={
            "log_id": log.id,
            "operator_id": log.operator_id,
            "checked_in_ip": current_ip,
            "checked_in_user_agent": current_user_agent,
        },
    )


def _default_photo_filename(action: str, operator_id: int) -> str:
    ts = timezone.now().strftime("%Y%m%d-%H%M%S")
    return f"{action}-op{operator_id}-{ts}.jpg"


def _replay_attendance_response(log: AttendanceLog, *, source: str) -> dict:
    """
    Build the same response shape as `_attendance_check_in` /
    `_attendance_check_out` from an already-existing log — used by the
    double-submit idempotency guard so the second POST completes with
    HTTP 200 + the original success payload instead of a bogus
    "photo already used" 400.

    We infer which side of the shift the original request was: if the
    log is still open → it was a check-in; if it's closed → it was a
    check-out (typical case is the rapid re-send hitting the very same
    endpoint that just closed the shift).
    """
    operator = log.operator
    if log.checked_out_at is None:
        return {
            "action": "check_in",
            "operator": {
                "id": operator.id,
                "full_name": operator.full_name,
            },
            "token": None,
            "username": None,
            "role": None,
            "was_late": log.was_late,
            "checked_in_at": log.checked_in_at.isoformat(),
            "source": source,
            "photo_url": log.checkin_photo.url if log.checkin_photo else None,
            "idempotent_replay": True,
        }
    duration_min = int((log.checked_out_at - log.checked_in_at).total_seconds() / 60)
    return {
        "action": "check_out",
        "operator": {
            "id": operator.id,
            "full_name": operator.full_name,
        },
        "duration_min": duration_min,
        "checked_out_at": log.checked_out_at.isoformat(),
        "source": source,
        "photo_url": log.checkout_photo.url if log.checkout_photo else None,
        "idempotent_replay": True,
    }


@transaction.atomic
def _attendance_check_in(
    *,
    operator,
    source,
    initiator,
    ip,
    user_agent,
    issue_token,
    settings_obj,
    photo_bytes: bytes | None = None,
    photo_filename: str | None = None,
    photo_phash: str = "",
) -> dict:
    now = timezone.now()

    # Determine was_late — уважаем **per-operator** shift_start. Если
    # оператор со сдвинутой сменой (например, вечерняя 14:00-22:00),
    # глобальный 10:00 из AttendanceSettings не должен ловить его на
    # «опоздание» в 13:50. `resolve_operator_config` уже сливает
    # per-op override с глобальным дефолтом.
    #
    # `late_threshold_min` (grace для флага was_late) пока остаётся
    # глобальным — per-op поля для него в модели нет; `grace_period_min`
    # на Operator относится к payroll-штрафу и семантически отделён.
    cfg = resolve_operator_config(operator)
    now_local = timezone.localtime(now)
    shift_start_time = cfg["shift_start"]
    if isinstance(shift_start_time, str):
        h, m = map(int, shift_start_time.split(":")[:2])
        shift_start_dt = now_local.replace(hour=h, minute=m, second=0, microsecond=0)
    else:
        shift_start_dt = now_local.replace(
            hour=shift_start_time.hour,
            minute=shift_start_time.minute,
            second=0,
            microsecond=0,
        )
    late_threshold = shift_start_dt + dt.timedelta(minutes=settings_obj.late_threshold_min)
    was_late = now_local > late_threshold

    # Get profile & User to issue token if required
    token_key = ""
    username = ""
    role = ""
    if issue_token:
        profile = Profile.objects.filter(operator=operator).first()
        if profile and profile.user:
            token, _ = Token.objects.get_or_create(user=profile.user)
            token_key = token.key
            username = profile.user.username
            role = profile.role

    log = AttendanceLog(
        operator=operator,
        checked_in_at=now,
        checked_in_ip=ip,
        checked_in_user_agent=user_agent,
        was_late=was_late,
        token_key=token_key,
        source=source,
        checkin_photo_phash=photo_phash,
    )
    if photo_bytes:
        fname = photo_filename or _default_photo_filename("checkin", operator.id)
        log.checkin_photo.save(fname, ContentFile(photo_bytes), save=False)
    log.save()

    audit_log_create(
        user=None,
        action="attendance.scan_ok",
        entity="AttendanceLog",
        entity_id=log.id,
        changes={
            "action_type": "check_in",
            "operator_id": operator.id,
            "source": source,
            "initiator": initiator,
            "has_photo": bool(photo_bytes),
        },
    )
    transaction.on_commit(
        lambda: _notify_managers_attendance(
            operator=operator, action="check_in", was_late=was_late
        )
    )

    return {
        "action": "check_in",
        "operator": {
            "id": operator.id,
            "full_name": operator.full_name,
        },
        "token": token_key if issue_token else None,
        "username": username if issue_token else None,
        "role": role if issue_token else None,
        "was_late": was_late,
        "checked_in_at": now.isoformat(),
        "source": source,
        "photo_url": log.checkin_photo.url if log.checkin_photo else None,
    }


@transaction.atomic
def _attendance_check_out(
    *,
    log,
    source,
    initiator,
    ip,
    user_agent,
    photo_bytes: bytes | None = None,
    photo_filename: str | None = None,
    photo_phash: str = "",
) -> dict:
    now = timezone.now()
    log.checked_out_at = now
    log.checked_out_ip = ip
    log.checked_out_user_agent = user_agent
    update_fields = [
        "checked_out_at",
        "checked_out_ip",
        "checked_out_user_agent",
    ]
    if photo_bytes:
        fname = photo_filename or _default_photo_filename("checkout", log.operator_id)
        log.checkout_photo.save(fname, ContentFile(photo_bytes), save=False)
        log.checkout_photo_phash = photo_phash
        update_fields += ["checkout_photo", "checkout_photo_phash"]
    log.save(update_fields=update_fields)

    # Invalidate token if present
    if log.token_key:
        Token.objects.filter(key=log.token_key).delete()

    audit_log_create(
        user=None,
        action="attendance.scan_ok",
        entity="AttendanceLog",
        entity_id=log.id,
        changes={
            "action_type": "check_out",
            "operator_id": log.operator_id,
            "source": source,
            "initiator": initiator,
            "has_photo": bool(photo_bytes),
        },
    )

    duration_min = int((now - log.checked_in_at).total_seconds() / 60)
    op_ref = log.operator
    transaction.on_commit(
        lambda: _notify_managers_attendance(
            operator=op_ref, action="check_out", duration_min=duration_min
        )
    )

    return {
        "action": "check_out",
        "operator": {
            "id": log.operator.id,
            "full_name": log.operator.full_name,
        },
        "duration_min": duration_min,
        "checked_out_at": now.isoformat(),
        "source": source,
        "photo_url": log.checkout_photo.url if log.checkout_photo else None,
    }


@transaction.atomic
def auto_close_open_logs(*, at: dt.datetime | None = None) -> int:
    target_time = at or timezone.now()
    open_logs = AttendanceLog.objects.filter(checked_out_at__isnull=True)
    count = open_logs.count()

    token_keys = list(open_logs.exclude(token_key="").values_list("token_key", flat=True))
    if token_keys:
        Token.objects.filter(key__in=token_keys).delete()

    open_logs.update(checked_out_at=target_time, auto_closed=True)
    return count


@transaction.atomic
def attendance_log_backfill_checkout(
    *,
    operator: Operator,
    log: AttendanceLog,
    checked_out_at: dt.datetime,
) -> AttendanceLog:
    """
    Оператор задним числом вводит фактическое время своего ухода — когда
    вчера забыл /checkout и cron auto-close'нул смену в 23:00.

    Что делаем:
      - валидируем: лог принадлежит оператору, был auto_closed, ещё не
        backfilled, `checked_out_at` в допустимом диапазоне;
      - переписываем `checked_out_at` на реальное время;
      - выставляем `backfilled_by_operator_at=now()` — селектор
        `forgotten_checkouts_count` перестаёт считать этот лог;
      - `auto_closed` **не сбрасываем** — сохраняем аудит (было закрыто
        кроном), но `backfilled_by_operator_at` даёт фронту и статистике
        понять, что оператор ответственно оформил уход.

    Валидация окна:
      - `>= checked_in_at + 30 минут` — защита от «случайно ввёл то же
        время что и приход».
      - `<= checked_in_at + AttendanceSettings.max_backfill_hours` (14
        часов по умолчанию) — защита от абсурдных значений.
      - `<= log.updated_at` (auto_closed timestamp) — уход не может быть
        позже момента, когда cron уже закрыл смену. `updated_at` тут
        proxy для «когда cron auto-close'нул», т.к. отдельного поля мы
        не заводили (auto_closed выставляется одной update-транзакцией).
    """
    if log.operator_id != operator.id:
        raise PermissionDenied("Это не ваш лог смены")
    # Prod-safety (2026-08-26): backfill доступен только тем операторам,
    # у которых явно включён enforcement (`require_checkin_enabled=True`).
    # Иначе кто угодно с валидным auto_closed логом мог бы через прямой
    # POST переписать время своего ухода — не то, что мы хотим на prod до
    # массового rollout'a.
    if not getattr(operator, "require_checkin_enabled", False):
        raise PermissionDenied(
            "Backfill недоступен: для вашего профиля не включена обязательная отметка прихода/ухода"
        )
    if not log.auto_closed:
        raise ValidationError("Лог не был закрыт автоматически — backfill не нужен")
    if log.backfilled_by_operator_at is not None:
        raise ValidationError("Лог уже подтверждён — нельзя переписать повторно")
    if log.checked_out_at is None:
        raise ValidationError("Лог ещё открыт — backfill не применим")

    if timezone.is_naive(checked_out_at):
        checked_out_at = timezone.make_aware(
            checked_out_at, timezone.get_current_timezone()
        )

    settings_obj = attendance_settings_get()
    max_hours = int(settings_obj.max_backfill_hours or 14)

    lower_bound = log.checked_in_at + dt.timedelta(minutes=30)
    upper_bound = log.checked_in_at + dt.timedelta(hours=max_hours)

    if checked_out_at < lower_bound:
        raise ValidationError(
            f"Время ухода должно быть минимум через 30 минут после прихода"
        )
    if checked_out_at > upper_bound:
        raise ValidationError(
            f"Время ухода не может быть позже {max_hours} часов от прихода"
        )
    # auto_closed timestamp — верхняя граница «cron уже сработал».
    # `log.checked_out_at` was set by `auto_close_open_logs` — не даём
    # ввести время позже этого момента (значит, оператор был бы всё ещё
    # на смене после cron auto-close, что противоречит логике).
    if log.checked_out_at is not None and checked_out_at > log.checked_out_at:
        raise ValidationError(
            "Время ухода не может быть позже момента, когда смена была авто-закрыта"
        )

    now = timezone.now()
    log.checked_out_at = checked_out_at
    log.backfilled_by_operator_at = now
    log.save(update_fields=["checked_out_at", "backfilled_by_operator_at"])

    audit_log_create(
        user=None,
        action="attendance.checkout_backfilled",
        entity="AttendanceLog",
        entity_id=log.id,
        changes={
            "log_id": log.id,
            "operator_id": operator.id,
            "new_checked_out_at": checked_out_at.isoformat(),
            "auto_closed_still": True,
        },
    )

    # Уведомляем менеджеров, что оператор оформил забытый уход задним
    # числом — прозрачность для «форбидд/забыл выйти» разговоров.
    def _notify_managers_backfill():
        try:
            from apps.notifications.models import Notification, NotificationKind
            from apps.users.models import Role

            managers = User.objects.filter(
                profile__role__in=(Role.MANAGER, Role.TEAM_LEAD, Role.SUPERADMIN),
                is_active=True,
            )
            if not managers.exists():
                return
            duration_min = int(
                (checked_out_at - log.checked_in_at).total_seconds() / 60
            )
            hours = round(duration_min / 60, 1)
            Notification.objects.bulk_create(
                [
                    Notification(
                        recipient=m,
                        kind=NotificationKind.SYSTEM,
                        title=f"⏱ {operator.full_name} — уход задним числом",
                        body=f"Смена {hours} ч (оформлено сегодня)",
                        link=f"/operators/{operator.id}",
                        metadata={
                            "kind": "attendance_backfill",
                            "operator_id": operator.id,
                            "log_id": log.id,
                            "duration_min": duration_min,
                        },
                    )
                    for m in managers
                ]
            )
        except Exception:
            import logging

            logging.getLogger("attendance").warning(
                "backfill notify failed log=%s", log.id, exc_info=True
            )

    transaction.on_commit(_notify_managers_backfill)
    return log


def resolve_operator_config(operator: Operator) -> dict:
    """
    Собирает единый payroll-конфиг для оператора: сливает per-operator
    override'ы (если заданы) с глобальными дефолтами из `AttendanceSettings`.

    Ключи:
      - `attendance_bonus_uzs`  Decimal — размер attendance-блока
      - `sales_bonus_uzs`       Decimal — размер sales-блока
      - `sales_gate_pct`        int — гейт по плану продаж
      - `monthly_plan_uzs`      Decimal — план продаж fallback (когда нет
                                OperatorMonthlyPlan за месяц)
      - `salary_uzs`            Decimal — deprecated alias, всегда равен
                                `attendance_bonus_uzs` (совместимость)
      - `shift_start` / `shift_end` — рабочая смена
      - `grace_period_min`       int
      - `late_penalty_uzs`       Decimal
      - `weekly_day_off`         int (0=Пн … 6=Вс)
      - `attendance_gate_pct`    int — глобальный из AttendanceSettings
      - `weekly_free_absences`   int

    Fallback attendance-бонуса:
      Operator.attendance_bonus_uzs
      → Operator.salary_uzs                 (deprecated alias, оставлен
                                            чтобы не терять настроенных
                                            менеджеров до апгрейда)
      → AttendanceSettings.default_attendance_bonus_uzs
      → AttendanceSettings.default_salary_uzs (deprecated alias)
    """
    s = attendance_settings_get()

    def _or_default(op_val, default):
        # `is not None` для числовых/Decimal полей — 0 не должно быть
        # интерпретировано как «не задано».
        return op_val if op_val is not None else default

    # Attendance-бонус — двойной fallback: сначала новое поле, потом
    # старое salary_uzs (per-operator и global) для обратной совместимости.
    op_attendance_bonus = _or_default(
        operator.attendance_bonus_uzs, operator.salary_uzs
    )
    settings_attendance_bonus = _or_default(
        s.default_attendance_bonus_uzs, s.default_salary_uzs
    )
    attendance_bonus = Decimal(
        _or_default(op_attendance_bonus, settings_attendance_bonus)
    )
    sales_bonus = Decimal(
        _or_default(operator.sales_bonus_uzs, s.default_sales_bonus_uzs)
    )
    sales_gate = int(
        _or_default(operator.sales_gate_pct, s.default_sales_gate_pct)
    )
    monthly_plan = Decimal(s.default_monthly_plan_uzs)

    return {
        "attendance_bonus_uzs": attendance_bonus,
        "sales_bonus_uzs": sales_bonus,
        "sales_gate_pct": sales_gate,
        "monthly_plan_uzs": monthly_plan,
        # Deprecated alias — старый код (тесты, миграция) читает
        # `salary_uzs`; отдаём тот же attendance-бонус, чтобы ничего не
        # ломалось до полного refactor'а вызывающего кода.
        "salary_uzs": attendance_bonus,
        "shift_start": _or_default(operator.shift_start, s.shift_start),
        "shift_end": _or_default(operator.shift_end, s.shift_end),
        "grace_period_min": int(
            _or_default(operator.grace_period_min, s.default_grace_period_min)
        ),
        "late_penalty_uzs": Decimal(
            _or_default(operator.late_penalty_uzs, s.default_late_penalty_uzs)
        ),
        "weekly_day_off": int(
            _or_default(operator.weekly_day_off, s.default_weekly_day_off)
        ),
        "attendance_gate_pct": int(s.default_attendance_gate_pct),
        "weekly_free_absences": int(
            _or_default(operator.weekly_free_absences, s.default_weekly_free_absences)
        ),
    }


def _time_to_time(value) -> dt.time:
    """Утилита: строка `"HH:MM"` или `datetime.time` → `datetime.time`."""
    if isinstance(value, dt.time):
        return value
    if isinstance(value, str):
        parts = value.split(":")
        return dt.time(int(parts[0]), int(parts[1] if len(parts) > 1 else 0))
    raise TypeError(f"Cannot coerce {type(value)!r} to datetime.time")


def payroll_pdf_bytes(
    *,
    operator_name: str,
    year: int,
    month: int,
    summary: dict,
) -> bytes:
    """
    Простой одностраничный PDF отчёта: заголовок + summary + таблица дней.

    Реализован через `reportlab.platypus.SimpleDocTemplate` — так layout
    сам растягивается по вертикали, не требуя ручной верстки. Из
    зависимостей: только reportlab (pure-python, без системных .so).
    """
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.lib.units import cm
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from reportlab.platypus import (
        Paragraph,
        SimpleDocTemplate,
        Spacer,
        Table,
        TableStyle,
    )

    # Пытаемся зарегистрировать DejaVu (есть в reportlab-samples и обычно
    # доступен в системе), иначе fallback на Helvetica — но кириллица
    # в Helvetica кривая. Ставим DejaVu если найдём.
    body_font = "Helvetica"
    bold_font = "Helvetica-Bold"
    for candidate in (
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/dejavu/DejaVuSans.ttf",
        "/Library/Fonts/DejaVuSans.ttf",
        "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
    ):
        try:
            import os

            if os.path.exists(candidate):
                pdfmetrics.registerFont(TTFont("DejaVu", candidate))
                bold_candidate = candidate.replace("DejaVuSans.ttf", "DejaVuSans-Bold.ttf")
                if os.path.exists(bold_candidate):
                    pdfmetrics.registerFont(TTFont("DejaVu-Bold", bold_candidate))
                    bold_font = "DejaVu-Bold"
                else:
                    bold_font = "DejaVu"
                body_font = "DejaVu"
                break
        except Exception:
            continue

    buf = BytesIO()
    doc = SimpleDocTemplate(
        buf,
        pagesize=A4,
        leftMargin=1.5 * cm,
        rightMargin=1.5 * cm,
        topMargin=1.5 * cm,
        bottomMargin=1.5 * cm,
        title=f"Payroll {operator_name} {year}-{month:02d}",
    )
    styles = getSampleStyleSheet()
    title_style = ParagraphStyle(
        "title",
        parent=styles["Title"],
        fontName=bold_font,
        fontSize=16,
        spaceAfter=6,
    )
    normal = ParagraphStyle(
        "normal",
        parent=styles["Normal"],
        fontName=body_font,
        fontSize=10,
        leading=14,
    )
    small = ParagraphStyle(
        "small",
        parent=styles["Normal"],
        fontName=body_font,
        fontSize=8,
        leading=10,
        textColor=colors.HexColor("#6B7280"),
    )

    def fmt_uzs(v) -> str:
        try:
            return f"{int(Decimal(str(v))):,}".replace(",", " ")
        except Exception:
            return str(v)

    attendance = summary.get("attendance") or {}
    sales = summary.get("sales") or {}
    att_shortfall = attendance.get("shortfall") or {}
    sales_shortfall = sales.get("shortfall") or {}

    story = []
    story.append(Paragraph(f"Расчёт зарплаты — {operator_name}", title_style))
    story.append(
        Paragraph(f"Период: {year}-{month:02d} · тайм-зона Asia/Tashkent", small)
    )
    story.append(Spacer(1, 0.4 * cm))

    # ---- Total block ----
    total_rows = [
        [
            "Итого к выплате",
            f"{fmt_uzs(summary.get('total_earned', 0))} сум "
            f"из {fmt_uzs(summary.get('max_possible', 0))} сум",
        ],
    ]
    total_tbl = Table(total_rows, colWidths=[6 * cm, 10 * cm])
    total_tbl.setStyle(
        TableStyle(
            [
                ("FONT", (0, 0), (-1, -1), bold_font, 12),
                ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#F3F4F6")),
                ("BOX", (0, 0), (-1, -1), 0.4, colors.HexColor("#D1D5DB")),
                ("LEFTPADDING", (0, 0), (-1, -1), 8),
                ("RIGHTPADDING", (0, 0), (-1, -1), 8),
                ("TOPPADDING", (0, 0), (-1, -1), 6),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
            ]
        )
    )
    story.append(total_tbl)
    story.append(Spacer(1, 0.4 * cm))

    # ---- Attendance block ----
    att_gate_passed = attendance.get("gate_passed", False)
    att_status_line = (
        f"<b>Гейт {summary.get('attendance_gate_pct', 85)}% — "
        + ("пройден" if att_gate_passed else "НЕ пройден")
        + "</b>"
    )
    att_rows = [
        ["Attendance-блок", ""],
        ["Бонус", f"{fmt_uzs(summary.get('attendance_bonus_uzs', 0))} сум"],
        [
            "Посещаемость",
            f"{attendance.get('rate_pct', 0)}% "
            f"(порог {summary.get('attendance_gate_pct', 85)}%)",
        ],
        [
            "Дней",
            f"{attendance.get('days_attended', 0)} из "
            f"{attendance.get('working_days_planned', 0)} "
            f"(пропущено {attendance.get('days_absent', 0)})",
        ],
        [
            "Опозданий",
            (
                f"{attendance.get('days_late', 0)}"
                + (
                    f" (средн. {attendance.get('avg_late_minutes', 0)} мин)"
                    if attendance.get("days_late", 0)
                    else ""
                )
            ),
        ],
        [
            "Штраф за опоздания",
            f"−{fmt_uzs(attendance.get('late_penalty_total', 0))} сум"
            + (
                f" ({attendance.get('days_late', 0)} × "
                f"{fmt_uzs(attendance.get('late_penalty_per_event', 0))})"
                if attendance.get("days_late", 0) and att_gate_passed
                else ""
            ),
        ],
        [
            "Начислено",
            f"{fmt_uzs(attendance.get('block_earned', 0))} сум"
            + (" (гейт провален)" if not att_gate_passed else ""),
        ],
    ]
    att_tbl = Table(att_rows, colWidths=[6 * cm, 10 * cm])
    att_tbl.setStyle(
        TableStyle(
            [
                ("FONT", (0, 0), (-1, -1), body_font, 10),
                ("FONT", (0, 0), (-1, 0), bold_font, 11),
                ("FONT", (0, -1), (-1, -1), bold_font, 11),
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#F3F4F6")),
                ("BACKGROUND", (0, -1), (-1, -1), colors.HexColor("#F9FAFB")),
                ("BOX", (0, 0), (-1, -1), 0.4, colors.HexColor("#D1D5DB")),
                ("INNERGRID", (0, 1), (-1, -1), 0.2, colors.HexColor("#E5E7EB")),
                ("LEFTPADDING", (0, 0), (-1, -1), 8),
                ("RIGHTPADDING", (0, 0), (-1, -1), 8),
                ("TOPPADDING", (0, 0), (-1, -1), 4),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ]
        )
    )
    story.append(att_tbl)
    story.append(Spacer(1, 0.15 * cm))
    story.append(Paragraph(att_status_line, small))
    if att_shortfall.get("explanation"):
        story.append(Paragraph(att_shortfall["explanation"], small))
    story.append(Spacer(1, 0.4 * cm))

    # ---- Sales block ----
    sales_gate_passed = sales.get("gate_passed", False)
    sales_rows = [
        ["Sales-блок", ""],
        ["Бонус", f"{fmt_uzs(summary.get('sales_bonus_uzs', 0))} сум"],
        [
            "План продаж",
            f"{fmt_uzs(sales.get('plan_amount_uzs', 0))} сум",
        ],
        [
            "Факт продаж",
            f"{fmt_uzs(sales.get('actual_uzs', 0))} сум "
            f"({sales.get('rate_pct', 0)}%)",
        ],
        [
            "Гейт",
            f"{summary.get('sales_gate_pct', 85)}% — "
            + ("пройден" if sales_gate_passed else "НЕ пройден"),
        ],
        [
            "Начислено",
            f"{fmt_uzs(sales.get('block_earned', 0))} сум"
            + (" (гейт провален)" if not sales_gate_passed else ""),
        ],
    ]
    sales_tbl = Table(sales_rows, colWidths=[6 * cm, 10 * cm])
    sales_tbl.setStyle(
        TableStyle(
            [
                ("FONT", (0, 0), (-1, -1), body_font, 10),
                ("FONT", (0, 0), (-1, 0), bold_font, 11),
                ("FONT", (0, -1), (-1, -1), bold_font, 11),
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#F3F4F6")),
                ("BACKGROUND", (0, -1), (-1, -1), colors.HexColor("#F9FAFB")),
                ("BOX", (0, 0), (-1, -1), 0.4, colors.HexColor("#D1D5DB")),
                ("INNERGRID", (0, 1), (-1, -1), 0.2, colors.HexColor("#E5E7EB")),
                ("LEFTPADDING", (0, 0), (-1, -1), 8),
                ("RIGHTPADDING", (0, 0), (-1, -1), 8),
                ("TOPPADDING", (0, 0), (-1, -1), 4),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ]
        )
    )
    story.append(sales_tbl)
    if sales_shortfall.get("explanation"):
        story.append(Spacer(1, 0.15 * cm))
        story.append(Paragraph(sales_shortfall["explanation"], small))
    story.append(Spacer(1, 0.6 * cm))

    story.append(Paragraph("<b>Attendance по дням</b>", normal))
    story.append(Spacer(1, 0.2 * cm))

    day_header = [
        "Дата",
        "День",
        "Статус",
        "Приход",
        "Уход",
        "Опозд., мин",
        "Штраф, сум",
    ]
    weekday_ru = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"]
    status_ru = {
        "on_time": "В срок",
        "late": "Опоздал",
        "absent": "Пропуск",
        "free_absence": "Прощён",
        "weekend": "Выходной",
    }
    days_source = attendance.get("days") or summary.get("days") or []
    day_rows = [day_header]
    for d in days_source:
        day_rows.append(
            [
                d.get("date", ""),
                weekday_ru[int(d.get("weekday", 0))] if d.get("weekday") is not None else "",
                status_ru.get(d.get("status", ""), d.get("status", "")),
                (d.get("checked_in_at") or "—")[-8:-3]
                if d.get("checked_in_at")
                else "—",
                (d.get("checked_out_at") or "—")[-8:-3]
                if d.get("checked_out_at")
                else "—",
                str(d.get("minutes_late", 0) or 0),
                fmt_uzs(d.get("deduction_uzs", 0) or 0),
            ]
        )
    days_tbl = Table(
        day_rows,
        colWidths=[2.4 * cm, 1.4 * cm, 3.2 * cm, 2 * cm, 2 * cm, 2 * cm, 3 * cm],
        repeatRows=1,
    )
    days_tbl.setStyle(
        TableStyle(
            [
                ("FONT", (0, 0), (-1, 0), bold_font, 9),
                ("FONT", (0, 1), (-1, -1), body_font, 8),
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#111827")),
                ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
                ("ALIGN", (2, 0), (2, -1), "LEFT"),
                ("ALIGN", (3, 0), (-1, -1), "CENTER"),
                ("BOX", (0, 0), (-1, -1), 0.3, colors.HexColor("#D1D5DB")),
                ("INNERGRID", (0, 0), (-1, -1), 0.2, colors.HexColor("#E5E7EB")),
                ("LEFTPADDING", (0, 0), (-1, -1), 4),
                ("RIGHTPADDING", (0, 0), (-1, -1), 4),
                ("TOPPADDING", (0, 0), (-1, -1), 3),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
            ]
        )
    )
    story.append(days_tbl)

    doc.build(story)
    return buf.getvalue()


def pdf_response(pdf_bytes: bytes, filename: str):
    """HTTP-response обёртка для PDF."""
    from django.http import HttpResponse

    resp = HttpResponse(pdf_bytes, content_type="application/pdf")
    resp["Content-Disposition"] = f'attachment; filename="{filename}"'
    return resp


@transaction.atomic
def attendance_log_manual_close(*, log: AttendanceLog, user, note: str = "") -> AttendanceLog:
    if log.checked_out_at is not None:
        raise ValidationError("Лог уже закрыт")
    now = timezone.now()
    log.checked_out_at = now
    log.manually_closed = True
    log.manually_closed_by = user
    log.manual_close_note = note
    log.save(
        update_fields=[
            "checked_out_at",
            "manually_closed",
            "manually_closed_by",
            "manual_close_note",
        ]
    )

    if log.token_key:
        Token.objects.filter(key=log.token_key).delete()

    audit_log_create(
        user=user,
        action="attendance.log_closed_manually",
        entity="AttendanceLog",
        entity_id=log.id,
        changes={
            "log_id": log.id,
            "operator_id": log.operator_id,
            "closed_by": user.id if user else None,
            "note": note,
        },
    )
    return log


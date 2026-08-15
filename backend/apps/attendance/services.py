import hmac
import hashlib
import secrets
import ipaddress
import datetime as dt
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
        stale_logs = AttendanceLog.objects.filter(
            checked_out_at__isnull=True,
            checked_in_ip=ip,
            checked_in_user_agent=user_agent,
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

    # Determine was_late
    now_local = timezone.localtime(now)
    shift_start_time = settings_obj.shift_start
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


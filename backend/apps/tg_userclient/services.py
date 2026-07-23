"""
Fat services for TG user-client auth flow and message ingestion.

All mutating operations live here (HackSoft pattern). Each service writes
an audit log entry. Session strings and verification codes are NEVER
included in audit diffs or log output.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta

from asgiref.sync import async_to_sync
from django.conf import settings
from django.db import IntegrityError, transaction
from django.utils import timezone

from apps.audit.services import AuditAction, audit_log_create
from apps.common.validators import normalize_uz_phone
from apps.leads.models import Lead

from .crypto import decrypt_session, encrypt_session
from .models import (
    TgBackfillJob,
    TgBackfillJobStatus,
    TgChat,
    TgChatKind,
    TgMessage,
    TgMessageDirection,
    TgMessageKind,
    TgSession,
    TgSessionStatus,
)

logger = logging.getLogger("apps.tg_userclient")


# ---------------------------------------------------------------------------
# Auth flow services
# ---------------------------------------------------------------------------

def session_start(
    *,
    operator_id: int,
    phone: str,
    consent: bool,
    user=None,
) -> TgSession:
    """
    Phase 1: create/update TgSession, send verification code via Telethon.

    A temporary TelegramClient is spun up just for the send_code_request,
    then disconnected. The partial session (containing the auth_key) is
    encrypted and saved so verify_code can resume from it.
    """
    if not consent:
        raise ValueError("consent_required")

    from telethon import TelegramClient
    from telethon.sessions import StringSession

    async def _send_code() -> tuple[str, str]:
        client = TelegramClient(
            StringSession(), settings.TG_API_ID, settings.TG_API_HASH
        )
        await client.connect()
        result = await client.send_code_request(phone)
        ss = client.session.save()
        await client.disconnect()
        return result.phone_code_hash, ss

    phone_code_hash, session_string = async_to_sync(_send_code)()

    cipher, cipher_version = encrypt_session(session_string)
    session, _created = TgSession.objects.update_or_create(
        operator_id=operator_id,
        defaults={
            "phone": phone,
            "phone_code_hash": phone_code_hash,
            "encrypted_session": cipher,
            "key_version": cipher_version,
            "status": TgSessionStatus.PENDING_CODE,
            "consent_at": timezone.now() if consent else None,
            "last_error": "",
        },
    )

    audit_log_create(
        user=user,
        action=AuditAction.CREATE,
        entity="tg_userclient.TgSession",
        entity_id=session.id,
        changes={"step": "send_code", "phone": phone},
        comment="TG session auth started",
    )
    return session


def session_verify_code(
    *,
    session: TgSession,
    code: str,
    user=None,
) -> TgSession:
    """
    Phase 2: verify the SMS/TG code. If 2FA is enabled, session transitions
    to PENDING_2FA. Otherwise it becomes ACTIVE.
    """
    from telethon import TelegramClient
    from telethon.errors import (
        PhoneCodeExpiredError,
        PhoneCodeInvalidError,
        SessionPasswordNeededError,
    )
    from telethon.sessions import StringSession

    partial_ss = decrypt_session(session.encrypted_session, key_version=session.key_version)

    async def _verify() -> tuple[str, str | None, int | None, str]:
        """Returns (new_status, new_session_string | None, tg_user_id, tg_username)."""
        client = TelegramClient(
            StringSession(partial_ss), settings.TG_API_ID, settings.TG_API_HASH
        )
        await client.connect()
        try:
            await client.sign_in(
                phone=session.phone,
                code=code,
                phone_code_hash=session.phone_code_hash,
            )
        except SessionPasswordNeededError:
            ss = client.session.save()
            await client.disconnect()
            return TgSessionStatus.PENDING_2FA, ss, None, ""

        me = await client.get_me()
        ss = client.session.save()
        await client.disconnect()
        return (
            TgSessionStatus.ACTIVE,
            ss,
            me.id if me else None,
            me.username or "" if me else "",
        )

    try:
        new_status, new_ss, tg_uid, tg_uname = async_to_sync(_verify)()
    except PhoneCodeInvalidError:
        raise ValueError("code_invalid")
    except PhoneCodeExpiredError:
        session.status = TgSessionStatus.PENDING_CODE
        session.phone_code_hash = ""
        session.save(update_fields=["status", "phone_code_hash", "updated_at"])
        raise ValueError("code_expired")

    session.status = new_status
    session.phone_code_hash = ""  # no longer needed
    if new_ss:
        cipher, cipher_version = encrypt_session(new_ss)
        session.encrypted_session = cipher
        session.key_version = cipher_version
    if tg_uid:
        session.tg_user_id = tg_uid
        session.tg_username = tg_uname
    if new_status == TgSessionStatus.ACTIVE:
        session.last_connected_at = timezone.now()
    session.save()

    if session.status == TgSessionStatus.ACTIVE:
        _ensure_backfill_job(session)

    audit_log_create(
        user=user,
        action=AuditAction.UPDATE,
        entity="tg_userclient.TgSession",
        entity_id=session.id,
        changes={"step": "verify_code", "new_status": new_status},
        comment="TG session code verified",
    )
    return session


def session_verify_password(
    *,
    session: TgSession,
    password: str,
    user=None,
) -> TgSession:
    """Phase 3: verify the 2FA cloud password."""
    from telethon import TelegramClient
    from telethon.errors import PasswordHashInvalidError
    from telethon.sessions import StringSession

    partial_ss = decrypt_session(session.encrypted_session, key_version=session.key_version)

    async def _verify_2fa() -> tuple[str, int | None, str]:
        client = TelegramClient(
            StringSession(partial_ss), settings.TG_API_ID, settings.TG_API_HASH
        )
        await client.connect()
        await client.sign_in(password=password)
        me = await client.get_me()
        ss = client.session.save()
        await client.disconnect()
        return ss, me.id if me else None, me.username or "" if me else ""

    try:
        new_ss, tg_uid, tg_uname = async_to_sync(_verify_2fa)()
    except PasswordHashInvalidError:
        raise ValueError("password_invalid")

    session.status = TgSessionStatus.ACTIVE
    cipher, cipher_version = encrypt_session(new_ss)
    session.encrypted_session = cipher
    session.key_version = cipher_version
    session.phone_code_hash = ""
    session.last_connected_at = timezone.now()
    if tg_uid:
        session.tg_user_id = tg_uid
        session.tg_username = tg_uname
    session.save()

    _ensure_backfill_job(session)

    audit_log_create(
        user=user,
        action=AuditAction.UPDATE,
        entity="tg_userclient.TgSession",
        entity_id=session.id,
        changes={"step": "verify_password", "new_status": TgSessionStatus.ACTIVE},
        comment="TG session 2FA verified, now active",
    )
    return session


def session_revoke(*, session: TgSession, user=None) -> TgSession:
    """Revoke session: clear encrypted data, mark as REVOKED."""
    session.status = TgSessionStatus.REVOKED
    session.encrypted_session = b""
    session.phone_code_hash = ""
    session.last_error = ""
    session.save()

    audit_log_create(
        user=user,
        action=AuditAction.UPDATE,
        entity="tg_userclient.TgSession",
        entity_id=session.id,
        changes={"step": "revoke", "new_status": TgSessionStatus.REVOKED},
        comment="TG session revoked by user",
    )
    return session


# ---------------------------------------------------------------------------
# Message ingest service (called from runner event handler)
# ---------------------------------------------------------------------------

def _determine_message_kind(message) -> str:
    """Determine TgMessageKind from a Telethon Message object."""
    if message.voice:
        return TgMessageKind.VOICE
    if message.photo:
        return TgMessageKind.PHOTO
    if message.video:
        return TgMessageKind.VIDEO
    if message.sticker:
        return TgMessageKind.STICKER
    if message.message:
        return TgMessageKind.TEXT
    return TgMessageKind.OTHER


def _determine_chat_kind(peer) -> str | None:
    """Determine TgChatKind from a Telethon peer type."""
    from telethon.tl.types import PeerChannel, PeerChat, PeerUser

    if isinstance(peer, PeerUser):
        return TgChatKind.PRIVATE
    if isinstance(peer, PeerChat):
        return TgChatKind.GROUP
    if isinstance(peer, PeerChannel):
        # We'll refine this in the handler to check if it's a megagroup
        return TgChatKind.CHANNEL
    return None


def tg_message_ingest(
    *,
    session_id: int,
    tg_chat_id: int,
    chat_kind: str,
    chat_title: str,
    partner_name: str,
    partner_phone: str,
    tg_message_id: int,
    direction: str,
    message_kind: str,
    text: str,
    voice_duration_sec: int | None,
    sent_at: datetime,
    is_channel: bool = False,
) -> TgMessage | None:
    """
    Ingest a single message from Telethon event into the DB.

    Handles:
    - Channel messages are ignored (spec: only private + group)
    - get_or_create for TgChat
    - Lead matching by phone
    - Idempotency via unique_together on (chat, tg_message_id)
    """
    # Ignore channels
    if is_channel:
        return None

    session = TgSession.objects.filter(id=session_id).first()
    if not session:
        logger.warning("tg_message_ingest: session %s not found", session_id)
        return None

    # get_or_create chat
    chat, chat_created = TgChat.objects.get_or_create(
        session=session,
        tg_chat_id=tg_chat_id,
        defaults={
            "kind": chat_kind,
            "title": chat_title,
            "partner_name": partner_name,
            "partner_phone": partner_phone,
        },
    )

    # Update partner info if missing
    if not chat.partner_name and partner_name:
        chat.partner_name = partner_name
    if not chat.partner_phone and partner_phone:
        chat.partner_phone = partner_phone
    chat.last_message_at = sent_at
    chat.save(update_fields=["partner_name", "partner_phone", "last_message_at", "updated_at"])

    # Lead matching by phone
    if chat.lead_id is None and chat.partner_phone:
        normalized, valid = normalize_uz_phone(chat.partner_phone)
        if valid:
            lead = Lead.objects.filter(phone=normalized).first()
            if lead:
                chat.lead = lead
                chat.save(update_fields=["lead", "updated_at"])

    # Determine transcript status for voice
    transcript_status = ""
    if message_kind == TgMessageKind.VOICE:
        tg_transcribe = getattr(settings, "TG_TRANSCRIBE_VOICE", False)
        transcript_status = "pending" if tg_transcribe else "skipped"

    # Create message (idempotent via unique_together)
    try:
        with transaction.atomic():
            msg = TgMessage.objects.create(
                chat=chat,
                tg_message_id=tg_message_id,
                direction=direction,
                kind=message_kind,
                text=text,
                transcript_status=transcript_status,
                voice_duration_sec=voice_duration_sec,
                sent_at=sent_at,
            )
    except IntegrityError:
        # Duplicate tg_message_id — idempotent
        logger.debug(
            "Duplicate message: chat=%s tg_msg_id=%s",
            chat.id, tg_message_id,
        )
        return None

    return msg


# ---------------------------------------------------------------------------
# Backfill job services
# ---------------------------------------------------------------------------

def _parse_backfill_since() -> datetime:
    from datetime import timezone as dt_tz
    v = (getattr(settings, "TG_BACKFILL_SINCE", "") or "").strip()
    if not v:
        raise ValueError("TG_BACKFILL_SINCE not configured")
    dt = datetime.fromisoformat(v)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=dt_tz.utc)
    return dt


def _ensure_backfill_job(session: TgSession) -> TgBackfillJob | None:
    """
    Create a fresh PENDING job for this session if there's none PENDING/RUNNING.
    Idempotent: if a job is already in flight, return it without creating a new one.
    """
    try:
        since = _parse_backfill_since()
    except ValueError:
        return None  # backfill disabled

    existing = TgBackfillJob.objects.filter(
        session=session,
        status__in=[TgBackfillJobStatus.PENDING, TgBackfillJobStatus.RUNNING],
    ).first()
    if existing:
        return existing

    job = TgBackfillJob.objects.create(session=session, since=since)
    audit_log_create(
        user=None,
        action=AuditAction.CREATE,
        entity="tg_userclient.TgBackfillJob",
        entity_id=job.id,
        changes={"since": since.isoformat(), "session_id": session.id},
        comment="Created TG backfill job",
    )
    return job


def _mark_running(job: TgBackfillJob) -> None:
    job.status = TgBackfillJobStatus.RUNNING
    job.started_at = timezone.now()
    job.save(update_fields=["status", "started_at", "updated_at"])
    audit_log_create(
        user=None,
        action=AuditAction.UPDATE,
        entity="tg_userclient.TgBackfillJob",
        entity_id=job.id,
        changes={"status": TgBackfillJobStatus.RUNNING},
        comment="TG backfill job started",
    )


def _mark_done(job: TgBackfillJob, chats: int, messages: int) -> None:
    job.status = TgBackfillJobStatus.DONE
    job.finished_at = timezone.now()
    job.chats_scanned = chats
    job.messages_saved = messages
    job.save(
        update_fields=[
            "status",
            "finished_at",
            "chats_scanned",
            "messages_saved",
            "updated_at",
        ]
    )
    audit_log_create(
        user=None,
        action=AuditAction.UPDATE,
        entity="tg_userclient.TgBackfillJob",
        entity_id=job.id,
        changes={
            "status": TgBackfillJobStatus.DONE,
            "chats_scanned": chats,
            "messages_saved": messages,
        },
        comment="TG backfill job completed",
    )


def _mark_error(job: TgBackfillJob, err: str) -> None:
    job.status = TgBackfillJobStatus.ERROR
    job.finished_at = timezone.now()
    job.last_error = err[:2000]
    job.save(
        update_fields=["status", "finished_at", "last_error", "updated_at"]
    )
    audit_log_create(
        user=None,
        action=AuditAction.UPDATE,
        entity="tg_userclient.TgBackfillJob",
        entity_id=job.id,
        changes={"status": TgBackfillJobStatus.ERROR, "error": err[:500]},
        comment="TG backfill job failed",
    )


def _reset_stale_running_jobs() -> int:
    """Reset jobs stuck in RUNNING for >10 minutes back to PENDING."""
    cutoff = timezone.now() - timedelta(minutes=10)
    stale_jobs = TgBackfillJob.objects.filter(
        status=TgBackfillJobStatus.RUNNING,
        updated_at__lt=cutoff,
    )
    count = 0
    for job in stale_jobs:
        job.status = TgBackfillJobStatus.PENDING
        job.save(update_fields=["status", "updated_at"])
        count += 1
    return count


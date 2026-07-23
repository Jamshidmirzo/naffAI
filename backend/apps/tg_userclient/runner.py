"""
Asyncio runner process for TG user-client sessions.

Manages a pool of TelegramClient instances, one per active operator session.
Listens for events.NewMessage and delegates to handlers.on_new_message.
Processes pending backfill jobs for historical chat ingestion.

Runs as a separate process from Django's web server (management command
``run_tg_userclient``). Under systemd/supervisor in production.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone as dt_tz
from functools import partial

from django.conf import settings
from django.utils import timezone

from .crypto import TgSessionCryptoError, decrypt_session
from .models import TgSession, TgSessionStatus

logger = logging.getLogger("apps.tg_userclient")

# Interval between DB polls for session changes
SYNC_INTERVAL_SEC = 5


class ClientManager:
    """Manages a dict of operator_id -> TelegramClient and backfill tasks."""

    def __init__(self):
        self.clients: dict[int, object] = {}  # operator_id -> TelegramClient
        self._tasks: dict[int, asyncio.Task] = {}
        self._running_backfills: set[int] = set()

    async def sync_from_db(self) -> None:
        """
        Pull active sessions from DB, spawn new clients, disconnect revoked.
        Reset stale backfill jobs and trigger pending backfills.
        Called every SYNC_INTERVAL_SEC.
        """
        from asgiref.sync import sync_to_async
        from .services import _reset_stale_running_jobs

        # Reset stale running jobs back to PENDING
        await sync_to_async(_reset_stale_running_jobs)()

        active_sessions = await sync_to_async(
            lambda: list(
                TgSession.objects.filter(status=TgSessionStatus.ACTIVE)
                .values_list("id", "operator_id", "encrypted_session", "key_version")
            )
        )()

        active_op_ids = set()
        for session_id, operator_id, encrypted_session, key_version in active_sessions:
            active_op_ids.add(operator_id)
            if operator_id not in self.clients:
                try:
                    await self._spawn_client(
                        session_id, operator_id, encrypted_session, key_version
                    )
                except TgSessionCryptoError:
                    logger.error(
                        "Cannot decrypt session for operator %s, marking expired",
                        operator_id,
                    )
                    await self._mark_session_error(
                        session_id, TgSessionStatus.EXPIRED,
                        "Session decryption failed"
                    )
                except Exception as exc:
                    logger.exception(
                        "Failed to spawn client for operator %s: %s",
                        operator_id, exc,
                    )
                    await self._mark_session_error(
                        session_id, TgSessionStatus.ERROR, str(exc)
                    )

        # Disconnect clients for sessions that are no longer active
        to_remove = [op_id for op_id in self.clients if op_id not in active_op_ids]
        for op_id in to_remove:
            await self._disconnect_client(op_id)

        # Pick pending backfills
        await self._pick_pending_backfills()

    async def _pick_pending_backfills(self) -> None:
        from asgiref.sync import sync_to_async
        from .models import TgBackfillJob, TgBackfillJobStatus

        pending = await sync_to_async(
            lambda: list(
                TgBackfillJob.objects.filter(
                    status=TgBackfillJobStatus.PENDING,
                    session__status=TgSessionStatus.ACTIVE,
                ).select_related("session")
            )
        )()

        for job in pending:
            client = self.clients.get(job.session.operator_id)
            if client is None:
                continue
            if job.id in self._running_backfills:
                continue
            self._running_backfills.add(job.id)
            asyncio.create_task(self._run_backfill(client, job))

    async def _run_backfill(self, client: object, job: object) -> None:
        from asgiref.sync import sync_to_async
        from telethon.errors import FloodWaitError
        from .services import _mark_done, _mark_error, _mark_running

        logger.info(
            "backfill#%s start op=%s since=%s",
            job.id, job.session.operator_id, job.since.isoformat()
        )
        await sync_to_async(_mark_running)(job)

        try:
            chats_scanned = 0
            messages_saved = 0
            async for dialog in client.iter_dialogs():
                is_channel = getattr(dialog, "is_channel", False)
                is_group = getattr(dialog, "is_group", False)
                if is_channel and not is_group:
                    continue  # Pure channel — skip

                saved = await self._backfill_one_chat(client, job.session, dialog, job.since)
                messages_saved += saved
                chats_scanned += 1
                delay_sec = getattr(settings, "TG_BACKFILL_CHAT_DELAY_MS", 800) / 1000.0
                await asyncio.sleep(delay_sec)

            await sync_to_async(_mark_done)(job, chats_scanned, messages_saved)
            logger.info(
                "backfill#%s done chats=%s messages=%s",
                job.id, chats_scanned, messages_saved
            )
        except FloodWaitError as fw:
            logger.warning("backfill#%s FloodWait %ss — pausing", job.id, fw.seconds)
            await asyncio.sleep(fw.seconds + 5)
        except Exception as exc:
            await sync_to_async(_mark_error)(job, repr(exc))
            logger.exception("backfill#%s failed", job.id)
        finally:
            self._running_backfills.discard(job.id)

    async def _backfill_one_chat(
        self, client: object, session: object, dialog: object, since: datetime
    ) -> int:
        from asgiref.sync import sync_to_async
        from .models import TgChatKind, TgMessageDirection
        from .services import _determine_message_kind, tg_message_ingest

        entity = dialog.entity

        chat_kind = TgChatKind.PRIVATE
        tg_chat_id = dialog.id
        if getattr(dialog, "is_user", False):
            chat_kind = TgChatKind.PRIVATE
        elif getattr(dialog, "is_group", False):
            chat_kind = TgChatKind.GROUP

        partner_name = ""
        partner_phone = ""
        chat_title = ""
        if chat_kind == TgChatKind.PRIVATE:
            partner_name = " ".join(
                filter(None, [
                    getattr(entity, "first_name", ""),
                    getattr(entity, "last_name", ""),
                ])
            )
            partner_phone = getattr(entity, "phone", "") or ""
        else:
            chat_title = getattr(dialog, "name", "") or getattr(entity, "title", "") or ""

        saved = 0
        max_msgs = getattr(settings, "TG_BACKFILL_MAX_MESSAGES_PER_CHAT", 10000)
        msg_count = 0

        async for msg in client.iter_messages(entity, limit=None, reverse=True):
            if msg_count >= max_msgs:
                logger.warning("backfill: hit max messages limit (%s) for chat %s", max_msgs, tg_chat_id)
                break
            msg_count += 1

            sent_at = msg.date
            if sent_at and sent_at.tzinfo is None:
                sent_at = sent_at.replace(tzinfo=dt_tz.utc)

            # Skip messages older than since
            if sent_at and sent_at < since:
                continue

            direction = TgMessageDirection.OUT if msg.out else TgMessageDirection.IN
            msg_kind = _determine_message_kind(msg)

            voice_duration = None
            if msg.voice and msg.document:
                for attr in msg.document.attributes:
                    if hasattr(attr, "duration"):
                        voice_duration = attr.duration
                        break

            try:
                created = await sync_to_async(tg_message_ingest)(
                    session_id=session.id,
                    tg_chat_id=tg_chat_id,
                    chat_kind=chat_kind,
                    chat_title=chat_title,
                    partner_name=partner_name,
                    partner_phone=partner_phone,
                    tg_message_id=msg.id,
                    direction=direction,
                    message_kind=msg_kind,
                    text=msg.message or "",
                    voice_duration_sec=voice_duration,
                    sent_at=sent_at,
                    is_channel=False,
                )
            except Exception:
                logger.exception("backfill: message ingest failed for msg %s, skipping", msg.id)
                continue

            if created:
                saved += 1

        return saved

    async def _spawn_client(
        self,
        session_id: int,
        operator_id: int,
        encrypted_session: bytes | memoryview,
        key_version: int,
    ) -> None:
        from telethon import TelegramClient, events
        from telethon.sessions import StringSession

        from .handlers import on_new_message

        session_string = decrypt_session(encrypted_session, key_version=key_version)
        client = TelegramClient(
            StringSession(session_string),
            settings.TG_API_ID,
            settings.TG_API_HASH,
        )

        client.add_event_handler(
            partial(on_new_message, session_id=session_id),
            events.NewMessage(incoming=True, outgoing=True),
        )

        await client.connect()

        if not await client.is_user_authorized():
            logger.warning(
                "Client for operator %s is not authorized, marking expired",
                operator_id,
            )
            await client.disconnect()
            await self._mark_session_error(
                session_id, TgSessionStatus.EXPIRED,
                "Session authorization lost"
            )
            return

        self.clients[operator_id] = client
        logger.info("Spawned TG client for operator %s (session %s)", operator_id, session_id)

        # Update last_connected_at
        from asgiref.sync import sync_to_async
        await sync_to_async(
            TgSession.objects.filter(id=session_id).update
        )(last_connected_at=timezone.now())

    async def _disconnect_client(self, operator_id: int) -> None:
        client = self.clients.pop(operator_id, None)
        if client:
            try:
                await client.disconnect()
            except Exception:
                pass
            logger.info("Disconnected TG client for operator %s", operator_id)

    async def _mark_session_error(
        self, session_id: int, new_status: str, error_msg: str
    ) -> None:
        from asgiref.sync import sync_to_async
        await sync_to_async(
            TgSession.objects.filter(id=session_id).update
        )(status=new_status, last_error=error_msg)

    async def disconnect_all(self) -> None:
        op_ids = list(self.clients.keys())
        for op_id in op_ids:
            await self._disconnect_client(op_id)


async def run_forever() -> None:
    """
    Main loop: sync from DB every SYNC_INTERVAL_SEC, keep clients alive.
    """
    manager = ClientManager()
    logger.info("TG userclient runner started")

    try:
        while True:
            try:
                await manager.sync_from_db()
            except Exception:
                logger.exception("Error during sync_from_db")
            await asyncio.sleep(SYNC_INTERVAL_SEC)
    except asyncio.CancelledError:
        logger.info("Runner cancelled, disconnecting all clients")
    finally:
        await manager.disconnect_all()
        logger.info("TG userclient runner stopped")

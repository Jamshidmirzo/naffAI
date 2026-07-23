"""
Event handlers for incoming/outgoing Telethon messages.

The handler extracts metadata from the event and delegates to
``tg_message_ingest`` service (keeping the handler thin).
"""

from __future__ import annotations

import logging
from datetime import timezone as dt_tz

from django.utils import timezone

logger = logging.getLogger("apps.tg_userclient")


async def on_new_message(event, *, session_id: int) -> None:
    """
    Telethon event handler: events.NewMessage(incoming=True, outgoing=True).

    Runs inside the asyncio runner process. DB writes go through Django ORM
    via sync_to_async or direct sync calls (Django ORM is thread-safe for
    single queries in asyncio context with proper CONN_MAX_AGE).
    """
    from asgiref.sync import sync_to_async
    from telethon.tl.types import PeerChannel, PeerChat, PeerUser

    from .models import TgChatKind, TgMessageDirection, TgMessageKind
    from .services import _determine_message_kind, tg_message_ingest

    message = event.message
    if not message:
        return

    # Determine peer info
    peer = message.peer_id
    if peer is None:
        return

    is_channel = False
    if isinstance(peer, PeerUser):
        tg_chat_id = peer.user_id
        chat_kind = TgChatKind.PRIVATE
    elif isinstance(peer, PeerChat):
        tg_chat_id = peer.chat_id
        chat_kind = TgChatKind.GROUP
    elif isinstance(peer, PeerChannel):
        tg_chat_id = peer.channel_id
        # Check if it's a megagroup (treated as GROUP) or a true channel
        try:
            entity = await event.get_chat()
            if getattr(entity, "megagroup", False):
                chat_kind = TgChatKind.GROUP
            else:
                chat_kind = TgChatKind.CHANNEL
                is_channel = True
        except Exception:
            chat_kind = TgChatKind.CHANNEL
            is_channel = True
    else:
        return

    # Skip channels (spec: only private + group)
    if is_channel:
        return

    # Direction
    direction = TgMessageDirection.OUT if message.out else TgMessageDirection.IN

    # Message kind
    msg_kind = _determine_message_kind(message)

    # Text content
    text = message.message or ""

    # Voice duration
    voice_duration = None
    if message.voice and message.document:
        for attr in message.document.attributes:
            if hasattr(attr, "duration"):
                voice_duration = attr.duration
                break

    # Chat metadata
    chat_title = ""
    partner_name = ""
    partner_phone = ""
    try:
        chat_entity = await event.get_chat()
        if isinstance(peer, PeerUser):
            partner_name = " ".join(
                filter(None, [
                    getattr(chat_entity, "first_name", ""),
                    getattr(chat_entity, "last_name", ""),
                ])
            )
            partner_phone = getattr(chat_entity, "phone", "") or ""
        else:
            chat_title = getattr(chat_entity, "title", "") or ""
    except Exception:
        pass

    # Sent timestamp
    sent_at = message.date
    if sent_at and sent_at.tzinfo is None:
        sent_at = sent_at.replace(tzinfo=dt_tz.utc)

    # Delegate to service (sync)
    await sync_to_async(tg_message_ingest)(
        session_id=session_id,
        tg_chat_id=tg_chat_id,
        chat_kind=chat_kind,
        chat_title=chat_title,
        partner_name=partner_name,
        partner_phone=partner_phone,
        tg_message_id=message.id,
        direction=direction,
        message_kind=msg_kind,
        text=text,
        voice_duration_sec=voice_duration,
        sent_at=sent_at,
        is_channel=is_channel,
    )

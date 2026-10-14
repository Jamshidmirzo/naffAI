"""
Server-Sent Events endpoint for in-app notifications.

Клиент (EventSource / fetch-stream) открывает GET
/api/notifications/stream/, бэкенд подписывается на redis-канал
`notif:user:<id>` и стримит каждый publish как `data: <json>\\n\\n`.
Comment-пинг каждые 25 сек держит коннект живым (nginx
proxy_read_timeout 1h).

Используем plain async Django view, не DRF APIView — у APIView
request/response pipeline синхронный, и `async def get` ломает dispatch
(«Response can't be used in await»). Авторизацию делаем руками через
rest_framework.authtoken, чтобы не тащить DRF-машинерию.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import AsyncIterator

from asgiref.sync import sync_to_async
from django.conf import settings
from django.contrib.auth import get_user_model
from django.http import HttpResponse, StreamingHttpResponse
from django.views.decorators.csrf import csrf_exempt

from .services import notif_channel

logger = logging.getLogger(__name__)

PING_INTERVAL_SEC = 25
User = get_user_model()


def _parse_token(request) -> str | None:
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Token "):
        return auth[6:].strip()
    # Fallback — токен в query string (на случай EventSource без
    # кастомных заголовков). Фронт сейчас шлёт через fetch+header,
    # но оставляем gracefully.
    tok = request.GET.get("token")
    return tok.strip() if tok else None


@sync_to_async
def _resolve_user(token: str):
    try:
        from rest_framework.authtoken.models import Token

        row = Token.objects.select_related("user").filter(key=token).first()
        if not row:
            return None
        return row.user if row.user and row.user.is_active else None
    except Exception as exc:
        logger.warning("sse: token resolve failed: %s", exc)
        return None


async def _event_stream(user_id: int) -> AsyncIterator[bytes]:
    url = getattr(settings, "REDIS_URL", "") or ""
    if not url:
        yield b": sse-disabled\n\n"
        return

    try:
        import redis.asyncio as aioredis  # type: ignore[import-not-found]
    except Exception:
        yield b": sse-disabled\n\n"
        return

    client = aioredis.from_url(url, socket_connect_timeout=3, socket_timeout=None)
    pubsub = client.pubsub()
    channel = notif_channel(user_id)

    try:
        await pubsub.subscribe(channel)
        yield f": subscribed {channel}\n\n".encode()

        while True:
            try:
                message = await asyncio.wait_for(
                    pubsub.get_message(ignore_subscribe_messages=True, timeout=PING_INTERVAL_SEC),
                    timeout=PING_INTERVAL_SEC + 2,
                )
            except asyncio.TimeoutError:
                message = None

            if message is None:
                yield b": ping\n\n"
                continue

            data = message.get("data")
            if isinstance(data, (bytes, bytearray)):
                try:
                    data = data.decode("utf-8")
                except Exception:
                    continue
            if not isinstance(data, str):
                continue
            try:
                json.loads(data)
                frame = data
            except Exception:
                frame = json.dumps({"raw": data})
            yield f"data: {frame}\n\n".encode()
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        logger.warning("sse stream error uid=%s: %s", user_id, exc)
    finally:
        try:
            await pubsub.unsubscribe(channel)
            await pubsub.close()
        except Exception:
            pass
        try:
            await client.close()
        except Exception:
            pass


@csrf_exempt
async def notification_stream_view(request):
    """
    Plain async Django view. Авторизация — вручную по DRF Token
    (та же схема что DRF-клиенты используют).
    """
    if request.method != "GET":
        return HttpResponse(status=405)

    url = getattr(settings, "REDIS_URL", "") or ""
    if not url:
        return HttpResponse(status=503, content=b"sse disabled: no redis")

    token = _parse_token(request)
    if not token:
        return HttpResponse(status=401)
    user = await _resolve_user(token)
    if user is None:
        return HttpResponse(status=401)

    response = StreamingHttpResponse(
        _event_stream(user.id),
        content_type="text/event-stream",
    )
    response["Cache-Control"] = "no-cache"
    response["X-Accel-Buffering"] = "no"
    response["Connection"] = "keep-alive"
    return response

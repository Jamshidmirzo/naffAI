"""
asterisk-listener.py — заготовка AMI listener для Asterisk.

НЕ реализовано полностью — это скелет. Полная логика будет
в `backend/apps/calls/management/commands/asterisk_ami_listener.py`
как часть Django management command, запускаемого отдельным
docker-compose сервисом `asterisk-listener` (см. docker-compose-additions.yml).

Задача listener'а:
  - держит постоянное TCP-соединение с Asterisk Manager Interface (AMI)
  - слушает события: DialBegin, DialEnd, BridgeEnter, Hangup, Cdr
  - POST'ит их в Django API /api/calls/asterisk-event/ для матчинга
    с CallAttempt по sip_call_id (= UniqueID)

Зависимости (добавить в backend/pyproject.toml когда фаза придёт):
    panoramisk==1.4   # async AMI client
    httpx==0.27
"""

from __future__ import annotations

import asyncio
import logging
import os
from datetime import datetime, timezone
from typing import Any

# Пока модуль-заготовка — импорты в try, чтобы файл не падал в CI
try:
    import httpx
    from panoramisk import Manager
except ImportError:  # pragma: no cover
    httpx = None  # type: ignore
    Manager = None  # type: ignore


log = logging.getLogger("asterisk_ami")


# ============================================================================
# Config
# ============================================================================

AMI_HOST = os.environ.get("ASTERISK_AMI_HOST", "asterisk")
AMI_PORT = int(os.environ.get("ASTERISK_AMI_PORT", "5038"))
AMI_USERNAME = os.environ.get("ASTERISK_AMI_USERNAME", "naffai")
AMI_SECRET = os.environ.get("ASTERISK_AMI_SECRET", "changeme")

NAFF_API_BASE = os.environ.get("NAFF_API_BASE", "https://naff.flek.uz")
NAFF_API_TOKEN = os.environ.get("NAFF_API_TOKEN", "changeme")

EVENT_ENDPOINT = f"{NAFF_API_BASE}/api/calls/asterisk-event/"


# ============================================================================
# HTTP helper
# ============================================================================


async def post_event(client: "httpx.AsyncClient", payload: dict[str, Any]) -> None:
    """Отправляет событие в Django API. Ретраит 3 раза."""
    for attempt in range(3):
        try:
            r = await client.post(
                EVENT_ENDPOINT,
                json=payload,
                headers={"X-Asterisk-Token": NAFF_API_TOKEN},
                timeout=10.0,
            )
            r.raise_for_status()
            return
        except Exception as exc:  # noqa: BLE001
            log.warning("POST attempt=%d failed: %s", attempt + 1, exc)
            await asyncio.sleep(2 ** attempt)
    log.error("event dropped: %s", payload)


# ============================================================================
# Event handlers
# ============================================================================


async def on_dial_begin(manager, event) -> None:
    """DialBegin — оператор нажал call, канал создан, идёт вызов."""
    payload = {
        "sip_call_id": event.get("Uniqueid"),
        "type": "dialing",
        "at": datetime.now(timezone.utc).isoformat(),
        "caller": event.get("CallerIDNum"),
        "destination": event.get("DestExten") or event.get("DialString"),
    }
    await post_event(manager._http, payload)


async def on_bridge_enter(manager, event) -> None:
    """BridgeEnter — 2 канала соединены = клиент ответил."""
    payload = {
        "sip_call_id": event.get("Uniqueid"),
        "linked_id": event.get("Linkedid"),
        "type": "answered",
        "at": datetime.now(timezone.utc).isoformat(),
    }
    await post_event(manager._http, payload)


async def on_hangup(manager, event) -> None:
    """Hangup — звонок завершён."""
    payload = {
        "sip_call_id": event.get("Uniqueid"),
        "type": "ended",
        "at": datetime.now(timezone.utc).isoformat(),
        "cause": event.get("Cause"),
        "cause_txt": event.get("Cause-txt"),
        # Duration придёт из CDR event, здесь может быть 0
        "duration_seconds": int(event.get("Duration", 0) or 0),
    }
    await post_event(manager._http, payload)


async def on_cdr(manager, event) -> None:
    """Cdr — итоговая запись после hangup (точные длительности)."""
    payload = {
        "sip_call_id": event.get("UniqueID"),
        "type": "cdr",
        "at": datetime.now(timezone.utc).isoformat(),
        "duration_seconds": int(event.get("Duration", 0) or 0),
        "billable_seconds": int(event.get("BillableSeconds", 0) or 0),
        "disposition": event.get("Disposition"),
        "start": event.get("StartTime"),
        "answer": event.get("AnswerTime"),
        "end": event.get("EndTime"),
    }
    await post_event(manager._http, payload)


# ============================================================================
# Main loop
# ============================================================================


async def main() -> None:  # pragma: no cover
    if Manager is None or httpx is None:
        raise RuntimeError(
            "panoramisk / httpx не установлены. "
            "Добавь в backend/pyproject.toml когда придёт время."
        )

    manager = Manager(
        host=AMI_HOST,
        port=AMI_PORT,
        username=AMI_USERNAME,
        secret=AMI_SECRET,
        ping_delay=10,
        reconnect_timeout=5,
    )
    manager._http = httpx.AsyncClient()

    manager.register_event("DialBegin", on_dial_begin)
    manager.register_event("BridgeEnter", on_bridge_enter)
    manager.register_event("Hangup", on_hangup)
    manager.register_event("Cdr", on_cdr)

    await manager.connect()
    log.info("AMI listener connected to %s:%s", AMI_HOST, AMI_PORT)

    try:
        await asyncio.Event().wait()  # run forever
    finally:
        await manager._http.aclose()
        manager.close()


if __name__ == "__main__":  # pragma: no cover
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )
    asyncio.run(main())

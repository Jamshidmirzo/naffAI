"""
Telegram push + inline keyboard factories for the ROP agent.

Uses sync ``httpx`` (same pattern as ``apps.common.alerts.alert_owner``) so
callers from management commands + WSGI handlers don't need an event loop.
We deliberately do NOT reuse ``alert_owner`` here because:
- Briefings and reminders are *not* alerts; they should bypass the 10-min
  rate-limit baked into ``alert_owner``.
- We need the Telegram ``message_id`` back for later ``edit_reply_markup``
  calls after owner clicks an inline button — ``alert_owner`` is fire-and-
  forget and swallows the response.

Keyboards (``approval_keyboard``, ``briefing_action_keyboard``) are built as
plain JSON-serialisable dicts so the module stays importable without aiogram
(tests, non-bot management commands, etc.).
"""

from __future__ import annotations

import json
import logging
from typing import Any

import httpx
from django.conf import settings

logger = logging.getLogger("apps.rop_agent.telegram")


def _owner_chat_id() -> int:
    return int(getattr(settings, "ROP_OWNER_TG_CHAT_ID", 88938071))


def send_to_owner(
    text: str,
    *,
    reply_markup: dict[str, Any] | None = None,
    parse_mode: str = "HTML",
    disable_preview: bool = True,
) -> int:
    """
    POST to Telegram Bot API; return the ``message_id`` on success, or 0.

    Never raises — logs and returns 0 on any failure so a broken TG never
    breaks a briefing/alert task.
    """
    token = getattr(settings, "TELEGRAM_BOT_TOKEN", "") or ""
    if not token:
        logger.warning("send_to_owner: TELEGRAM_BOT_TOKEN empty, skipping push")
        return 0
    body: dict[str, Any] = {
        "chat_id": _owner_chat_id(),
        "text": text,
        "parse_mode": parse_mode,
        "disable_web_page_preview": disable_preview,
    }
    if reply_markup is not None:
        body["reply_markup"] = json.dumps(reply_markup, ensure_ascii=False)
    try:
        resp = httpx.post(
            f"https://api.telegram.org/bot{token}/sendMessage",
            json=body,
            timeout=10.0,
        )
        data = resp.json()
        if not data.get("ok"):
            logger.warning("send_to_owner: TG not ok: %s", data)
            return 0
        return int(data["result"]["message_id"])
    except Exception:
        logger.exception("send_to_owner: TG send failed")
        return 0


# ---------------------------------------------------------------------------
# Inline-keyboard factories (plain dicts, aiogram-compatible)
# ---------------------------------------------------------------------------
def approval_keyboard(approval_id: int) -> dict[str, Any]:
    return {
        "inline_keyboard": [[
            {"text": "✅ Tasdiqlayman", "callback_data": f"rop_approve:{approval_id}"},
            {"text": "❌ Yo'q", "callback_data": f"rop_reject:{approval_id}"},
        ]]
    }


def briefing_action_keyboard() -> dict[str, Any]:
    return {
        "inline_keyboard": [[
            {"text": "✅ Reja qabul", "callback_data": "rop_brief:accept"},
            {"text": "🔄 Qayta tuz", "callback_data": "rop_brief:redo"},
            {"text": "⏸ Sukut 2h", "callback_data": "rop_brief:mute"},
        ]]
    }

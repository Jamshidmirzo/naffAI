"""
Telegram DM helpers used by the callback-reminder cron job.

Kept intentionally slim: no long-lived Bot() reuse, no shared aiohttp
session. `check_due_callbacks` shells out to `asyncio.run(send_callback_dm(...))`
per notification — we ship on the order of tens of DMs per tick, so the
per-call overhead is negligible and there's no shared state to leak.

The DM carries two inline-keyboard buttons:
  [ Сделано ]  → callbacks/{id}/done
  [ +15 мин ]  → callbacks/{id}/snooze?minutes=15

Handling for those callbacks lives in `runner.py` (registered when the
bot boots), because inline buttons come back as regular callback_query
events on the same dispatcher.
"""

from __future__ import annotations

import logging

from django.conf import settings

logger = logging.getLogger("tg_bot.notify")


async def send_callback_dm(user_id: int, reminder) -> bool:
    """
    Fire off one DM. Returns True iff Telegram accepted the message.

    `reminder` is a `calls.CallbackReminder` instance — accepted as a
    positional argument so callers don't have to import the model to
    build a dict payload.
    """
    token = getattr(settings, "TELEGRAM_BOT_TOKEN", "")
    if not token or not user_id:
        return False
    try:
        from aiogram import Bot
        from aiogram.types import (
            InlineKeyboardButton,
            InlineKeyboardMarkup,
        )
    except ImportError:
        logger.warning("aiogram missing — DM skipped")
        return False

    bot = Bot(token=token)
    try:
        text = _format_reminder(reminder)
        kb = InlineKeyboardMarkup(
            inline_keyboard=[
                [
                    InlineKeyboardButton(
                        text="✅ Сделано", callback_data=f"cb-done:{reminder.id}"
                    ),
                    InlineKeyboardButton(
                        text="⏰ +15 мин", callback_data=f"cb-snooze:{reminder.id}:15"
                    ),
                ]
            ]
        )
        await bot.send_message(user_id, text, parse_mode="HTML", reply_markup=kb)
        return True
    except Exception:
        logger.exception("send_callback_dm failed for user=%s cb=%s", user_id, reminder.id)
        return False
    finally:
        try:
            await bot.session.close()
        except Exception:
            pass


def _format_reminder(reminder) -> str:
    lead = reminder.lead
    name = lead.full_name or "(без имени)"
    return (
        f"<b>⏰ Callback</b>\n"
        f"Клиент: <b>{name}</b>\n"
        f"Телефон: <code>{lead.phone or lead.phone_raw or '?'}</code>\n"
        f"Товар: {lead.product_hint or '—'}\n"
        f"Назначено на: {reminder.remind_at:%d.%m %H:%M}"
    )

"""
Long-polling Telegram bot runner. Started by `docker compose --profile bot up bot`.

Listens to messages in `TELEGRAM_GROUP_ID` (or to forwards in a private chat),
runs the regex parser, and creates a pending Sale via the service layer.

We isolate Django setup here so this module is the entry point for the
`bot` container — no other process needs aiogram installed.
"""

from __future__ import annotations

import asyncio
import logging
import os

import django

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings.prod")
django.setup()

from django.conf import settings  # noqa: E402

from apps.tg_bot.services import create_pending_from_message  # noqa: E402

logger = logging.getLogger("tg_bot")


async def main() -> None:
    try:
        from aiogram import Bot, Dispatcher, types
        from aiogram.filters import CommandStart
    except ImportError:
        logger.error("aiogram not installed — install with `uv pip install aiogram`")
        return

    token = settings.TELEGRAM_BOT_TOKEN
    if not token:
        logger.warning("TELEGRAM_BOT_TOKEN is empty — refusing to start.")
        return

    bot = Bot(token=token)
    dp = Dispatcher()

    @dp.message(CommandStart())
    async def cmd_start(msg: types.Message) -> None:
        await msg.answer(
            "naffAI parser bot активен. Перешлите сообщения из группы — я создам черновики продаж."
        )

    @dp.message()
    async def on_message(msg: types.Message) -> None:
        text = msg.text or msg.caption or ""
        sale = await asyncio.to_thread(create_pending_from_message, text)
        if sale:
            await msg.reply(
                f"OK · черновик продажи #{sale.id} создан\n"
                f"IMEI {sale.imei} · {sale.phone_model}\n"
                f"Подтвердите в дашборде."
            )

    logger.info("Bot started — polling…")
    await dp.start_polling(bot)


if __name__ == "__main__":
    asyncio.run(main())

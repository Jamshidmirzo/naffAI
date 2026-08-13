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

from asgiref.sync import sync_to_async
from django.conf import settings
from django.utils import timezone

logger = logging.getLogger("tg_bot.notify")


async def send_callback_dm(user_id: int, reminder) -> bool:
    """
    Fire off one DM. Returns True iff Telegram accepted the message.

    `reminder` is a `calls.CallbackReminder` instance — accepted as a
    positional argument so callers don't have to import the model to
    build a dict payload.
    """
    from apps.tg_bot.models import BotSubscription

    token = getattr(settings, "TELEGRAM_BOT_TOKEN", "")
    if not token or not user_id:
        return False
    try:
        from aiogram import Bot
        from aiogram.exceptions import TelegramForbiddenError
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

        # Clear blocked_at if subscription exists and was blocked previously
        def _clear_blocked():
            sub = BotSubscription.objects.filter(chat_id=user_id).first()
            if sub and sub.blocked_at is not None:
                sub.blocked_at = None
                sub.save(update_fields=["blocked_at"])

        await sync_to_async(_clear_blocked)()
        return True
    except TelegramForbiddenError:
        def _mark_blocked():
            sub = BotSubscription.objects.filter(chat_id=user_id).first()
            if sub:
                if not sub.blocked_at:
                    sub.blocked_at = timezone.now()
                    sub.save(update_fields=["blocked_at"])
                return sub.id
            return None

        sub_id = await sync_to_async(_mark_blocked)()
        logger.info("skipping DM: operator blocked bot subscription=%s", sub_id or user_id)
        return False
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


async def send_long_shift_warning_dms(
    operator_tg_id: int | None,
    tl_tg_id: int | None,
    log_id: int,
    operator_name: str,
    hours: int,
) -> list[str]:
    """
    Sends long shift warning DMs to the operator and/or team lead.
    Returns list of recipients to whom messages were successfully sent, e.g. ["operator", "team_lead"].
    """
    token = getattr(settings, "TELEGRAM_BOT_TOKEN", "")
    sent_to = []
    if not token:
        logger.warning("TELEGRAM_BOT_TOKEN missing")
        return sent_to

    try:
        from aiogram import Bot
        from aiogram.types import InlineKeyboardButton, InlineKeyboardMarkup
    except ImportError:
        logger.warning("aiogram missing — DM skipped")
        return sent_to

    bot = Bot(token=token)
    try:
        if operator_tg_id:
            text_op = f"{operator_name}, ты работаешь уже {hours} часов. Забыла отметить уход?"
            kb = InlineKeyboardMarkup(
                inline_keyboard=[
                    [
                        InlineKeyboardButton(
                            text="🚪 Отметить уход",
                            callback_data=f"attendance:auto_checkout_confirm:{log_id}",
                        ),
                        InlineKeyboardButton(
                            text="💼 Нет, продолжаю",
                            callback_data=f"attendance:continue_working:{log_id}",
                        ),
                    ]
                ]
            )
            try:
                await bot.send_message(operator_tg_id, text_op, parse_mode="HTML", reply_markup=kb)
                sent_to.append("operator")
            except Exception as e:
                logger.warning("Failed to send long shift DM to operator %s: %s", operator_tg_id, e)

        if tl_tg_id:
            suffix = "" if operator_tg_id else " (нет TG у оператора)"
            text_tl = f"{operator_name} работает уже {hours} часов без check-out. Проверь.{suffix}"
            try:
                await bot.send_message(tl_tg_id, text_tl, parse_mode="HTML")
                sent_to.append("team_lead")
            except Exception as e:
                logger.warning("Failed to send long shift DM to team lead %s: %s", tl_tg_id, e)
    finally:
        try:
            await bot.session.close()
        except Exception:
            pass

    return sent_to


async def send_sale_created_dms(
    *,
    recipient_ids: list[int],
    operator_name: str,
    phone_model: str,
    amount_uzs: int,
    sheet_source_name: str | None,
    bonus_note: str,
    sale_id: int,
) -> int:
    """
    Broadcast a "new sale" DM to each senior in `recipient_ids`. Returns the
    number of DMs Telegram accepted. Silent no-op if the bot token is not
    configured or aiogram isn't installed.
    """
    token = getattr(settings, "TELEGRAM_BOT_TOKEN", "")
    if not token or not recipient_ids:
        return 0

    try:
        from aiogram import Bot
        from aiogram.exceptions import TelegramForbiddenError
    except ImportError:
        logger.warning("aiogram missing — sale DM skipped")
        return 0

    bot = Bot(token=token)
    sent = 0
    try:
        text = _format_sale_created(
            operator_name=operator_name,
            phone_model=phone_model,
            amount_uzs=amount_uzs,
            sheet_source_name=sheet_source_name,
            bonus_note=bonus_note,
            sale_id=sale_id,
        )
        for uid in recipient_ids:
            try:
                await bot.send_message(uid, text, parse_mode="HTML")
                sent += 1
            except TelegramForbiddenError:
                logger.info("skipping sale DM: user %s blocked bot", uid)
            except Exception as e:
                logger.warning("sale DM to %s failed: %s", uid, e)
    finally:
        try:
            await bot.session.close()
        except Exception:
            pass
    return sent


def _format_sale_created(
    *,
    operator_name: str,
    phone_model: str,
    amount_uzs: int,
    sheet_source_name: str | None,
    bonus_note: str,
    sale_id: int,
) -> str:
    def _fmt_uzs(n: int) -> str:
        return f"{n:,}".replace(",", " ")

    lines = [
        "💰 <b>Новая продажа</b>",
        f"Оператор: <b>{operator_name}</b>",
        f"Модель: {phone_model}",
        f"Сумма: <b>{_fmt_uzs(amount_uzs)} сум</b>",
        f"Источник: {sheet_source_name or 'Прямая'}",
    ]
    if bonus_note.strip():
        lines.append(f"🎁 Бонус: {bonus_note.strip()}")
    lines.append(f"\n#sale-{sale_id}")
    return "\n".join(lines)


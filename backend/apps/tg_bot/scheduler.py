"""
BotReport scheduler helpers — shared between the management command
`send_scheduled_reports` (production cron) and the API `send-now`
endpoint (manual trigger from the web UI).
"""

from __future__ import annotations

import asyncio
import datetime as dt
import logging

from asgiref.sync import sync_to_async
from django.conf import settings
from django.utils import timezone

from .models import BotAuditLog, BotChat, BotReport
from .renderer import render_report

log = logging.getLogger(__name__)

_WEEKDAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]


def report_should_fire(report: BotReport, now: dt.datetime) -> bool:
    """
    Return True if this report is due to fire at `now`. Fires when:
      - report is enabled;
      - today's weekday is in schedule_days (empty list = every day);
      - now.time() >= schedule_time;
      - not yet sent today (idempotency by last_sent_at.date()).
    """
    if not report.enabled:
        return False
    if report.schedule_days:
        if _WEEKDAY_KEYS[now.weekday()] not in report.schedule_days:
            return False
    if now.time() < report.schedule_time:
        return False
    if report.last_sent_at and timezone.localtime(report.last_sent_at).date() == now.date():
        return False
    return True


async def dispatch_report(bot, report: BotReport, mark_sent: bool = True) -> dict:
    """
    Send `report` to every active recipient. Returns
    {"sent": N, "failed": M, "chat_ids": [...]}.

    Blocked chats (TelegramForbiddenError) are auto-deactivated so the
    next run skips them.
    """
    from aiogram.exceptions import TelegramForbiddenError, TelegramBadRequest

    recipients = await sync_to_async(list)(
        report.recipients.filter(is_active=True)
    )
    if not recipients:
        return {"sent": 0, "failed": 0, "chat_ids": []}

    sent = 0
    failed = 0
    sent_chats: list[int] = []
    for chat in recipients:
        try:
            text = await sync_to_async(render_report)(report, chat)
        except Exception:
            log.exception("render_report failed report=%s chat=%s", report.id, chat.chat_id)
            failed += 1
            continue
        try:
            await bot.send_message(
                chat.chat_id,
                text,
                parse_mode="HTML",
                disable_web_page_preview=True,
            )
            sent += 1
            sent_chats.append(chat.chat_id)
            await sync_to_async(_write_audit)(chat, report, outcome="scheduled_sent")
        except TelegramForbiddenError:
            log.warning("chat %s blocked bot; deactivating", chat.chat_id)
            await sync_to_async(_deactivate_chat)(chat)
            failed += 1
            await sync_to_async(_write_audit)(
                chat, report, outcome="error", detail="TelegramForbiddenError"
            )
        except TelegramBadRequest as exc:
            failed += 1
            log.warning("chat %s bad request: %s", chat.chat_id, exc)
            await sync_to_async(_write_audit)(
                chat, report, outcome="error", detail=str(exc)[:400]
            )
        except Exception as exc:
            failed += 1
            log.exception("send failed report=%s chat=%s", report.id, chat.chat_id)
            await sync_to_async(_write_audit)(
                chat, report, outcome="error", detail=str(exc)[:400]
            )

    if mark_sent and sent:
        await sync_to_async(_mark_sent)(report)

    return {"sent": sent, "failed": failed, "chat_ids": sent_chats}


def _mark_sent(report: BotReport) -> None:
    report.last_sent_at = timezone.now()
    report.last_send_error = ""
    report.save(update_fields=["last_sent_at", "last_send_error", "updated_at"])


def _deactivate_chat(chat: BotChat) -> None:
    chat.is_active = False
    chat.blocked_at = timezone.now()
    chat.save(update_fields=["is_active", "blocked_at", "last_seen_at"])


def _write_audit(
    chat: BotChat, report: BotReport, outcome: str, detail: str = ""
) -> None:
    BotAuditLog.objects.create(
        chat_id=chat.chat_id,
        chat_kind=chat.kind,
        command=f"report:{report.id}",
        args=report.name[:200],
        outcome=outcome,
        error_detail=detail,
    )


def make_bot():
    """
    Standalone bot instance for one-off dispatch (send-now from API or the
    management command). Avoids importing runner.py so we don't spin up its
    dispatcher / handlers.
    """
    from aiogram import Bot
    from aiogram.client.default import DefaultBotProperties

    token = getattr(settings, "TELEGRAM_BOT_TOKEN", "") or ""
    if not token:
        raise RuntimeError("TELEGRAM_BOT_TOKEN is not configured")
    return Bot(token=token, default=DefaultBotProperties(parse_mode="HTML"))


async def send_report_now(report: BotReport) -> dict:
    """Manual trigger. Marks last_sent_at like a scheduled send."""
    bot = make_bot()
    try:
        return await dispatch_report(bot, report, mark_sent=True)
    finally:
        await bot.session.close()


def send_report_now_sync(report: BotReport) -> dict:
    """Blocking wrapper for DRF views."""
    return asyncio.run(send_report_now(report))

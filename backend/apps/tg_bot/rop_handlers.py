"""
ROP agent callback handlers for the aiogram bot.

Registered from ``apps/tg_bot/runner.py`` via :func:`register_rop_handlers`.
Kept in a dedicated module so the already-huge ``runner.py`` doesn't grow.

Patterns handled:
- ``rop_approve:<approval_id>`` — owner approved a PendingApproval
- ``rop_reject:<approval_id>``  — owner rejected
- ``rop_brief:accept|redo|mute``— briefing action buttons
"""

from __future__ import annotations

import logging

logger = logging.getLogger("apps.tg_bot.rop_handlers")


def register_rop_handlers(dp) -> None:
    """
    Attach callback_query handlers to the given Dispatcher.

    Imports are lazy so this module can be imported outside a running bot
    (e.g. from tests or management commands) without pulling aiogram errors.
    """
    try:
        from aiogram import F
        from aiogram.types import CallbackQuery
    except ImportError:  # pragma: no cover
        logger.warning("aiogram not available — ROP handlers not registered")
        return

    from asgiref.sync import sync_to_async

    from apps.rop_agent import services as rop_services

    @dp.callback_query(F.data.startswith("rop_approve:"))
    async def cb_rop_approve(cb: CallbackQuery) -> None:
        try:
            approval_id = int(cb.data.split(":", 1)[1])
        except (ValueError, IndexError):
            await cb.answer("Noto'g'ri payload", show_alert=True)
            return
        result = await sync_to_async(rop_services.execute_pending_approval)(
            approval_id, resolved_by_tg_user_id=cb.from_user.id if cb.from_user else None
        )
        if result.get("ok"):
            await cb.answer("✅ Tasdiqlandi")
            try:
                await cb.message.edit_reply_markup(reply_markup=None)
            except Exception:
                pass
        else:
            await cb.answer(f"❌ {result.get('error','xato')}", show_alert=True)

    @dp.callback_query(F.data.startswith("rop_reject:"))
    async def cb_rop_reject(cb: CallbackQuery) -> None:
        try:
            approval_id = int(cb.data.split(":", 1)[1])
        except (ValueError, IndexError):
            await cb.answer("Noto'g'ri payload", show_alert=True)
            return
        result = await sync_to_async(rop_services.reject_pending_approval)(
            approval_id, resolved_by_tg_user_id=cb.from_user.id if cb.from_user else None
        )
        if result.get("ok"):
            await cb.answer("❌ Rad etildi")
            try:
                await cb.message.edit_reply_markup(reply_markup=None)
            except Exception:
                pass
        else:
            await cb.answer(result.get("error", "xato"), show_alert=True)

    @dp.callback_query(F.data.startswith("rop_brief:"))
    async def cb_rop_brief(cb: CallbackQuery) -> None:
        action = cb.data.split(":", 1)[1] if ":" in cb.data else ""
        if action == "accept":
            await cb.answer("👍 Qabul")
            try:
                await cb.message.edit_reply_markup(reply_markup=None)
            except Exception:
                pass
        elif action == "mute":
            await sync_to_async(rop_services.mute)()
            await cb.answer("⏸ 2 soat sukut rejimi")
        elif action == "redo":
            await cb.answer("🔄 Qayta tuzish — V2 da keladi", show_alert=True)
        else:
            await cb.answer()

    logger.info("ROP agent handlers registered")

"""
ROP agent callback + command handlers for the aiogram bot.

Registered from ``apps/tg_bot/runner.py`` via :func:`register_rop_handlers`.
Kept in a dedicated module so the already-huge ``runner.py`` doesn't grow.

Callbacks (inline buttons):
- ``rop_approve:<approval_id>`` — owner approved a PendingApproval
- ``rop_reject:<approval_id>``  — owner rejected
- ``rop_brief:accept|redo|mute``— briefing action buttons

Commands (owner remote control — gated by ``settings.ROP_OWNER_TG_CHAT_ID``):
- ``/rop_test``    — liveness check (returns LLM provider + model)
- ``/rop_status``  — ROPState dump (mute, last_briefing_at, …)
- ``/rop_natija``  — current KPI snapshot (rule-based, no LLM)
- ``/rop_brifing`` — force today's morning briefing right now
- ``/rop_sukut [N]`` — mute for N hours (0 = unmute, default 2)
"""

from __future__ import annotations

import logging
from datetime import timedelta

logger = logging.getLogger("apps.tg_bot.rop_handlers")


def register_rop_handlers(dp) -> None:
    """
    Attach callback_query + owner-only command handlers to the given Dispatcher.

    Imports are lazy so this module can be imported outside a running bot
    (e.g. from tests or management commands) without pulling aiogram errors.
    """
    try:
        from aiogram import F
        from aiogram.filters import Command, CommandObject
        from aiogram.types import CallbackQuery, Message
    except ImportError:  # pragma: no cover
        logger.warning("aiogram not available — ROP handlers not registered")
        return

    from asgiref.sync import sync_to_async
    from django.conf import settings

    from apps.rop_agent import services as rop_services

    def _is_owner(message: Message) -> bool:
        """
        Chat guard: only the configured owner chat may invoke /rop_* commands.
        Single-tenant on purpose — we never want operators or random superadmins
        muting the agent or firing on-demand briefings for someone else's shop.
        """
        owner = int(getattr(settings, "ROP_OWNER_TG_CHAT_ID", 88938071))
        return bool(message.chat and message.chat.id == owner)

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

    # ------------------------------------------------------------------
    # Owner-only /rop_* commands
    # ------------------------------------------------------------------
    @dp.message(Command("rop_test"))
    async def cmd_rop_test(message: Message) -> None:
        if not _is_owner(message):
            return
        from apps.rop_agent import llm as rop_llm

        model = getattr(settings, "ROP_LLM_MODEL", "") or "—"
        base = getattr(settings, "ROP_LLM_BASE_URL", "") or "—"
        has_client = rop_llm._client() is not None
        llm_line = (
            f"🤖 LLM: <code>{model}</code> @ <code>{base}</code>"
            if has_client
            else "🤖 LLM: <i>stub mode (key/base_url missing)</i>"
        )
        enabled = "✅" if getattr(settings, "ROP_ENABLED", False) else "❌"
        await message.reply(
            f"✅ ROP agent ishlayapti\n{llm_line}\nROP_ENABLED={enabled}",
            parse_mode="HTML",
        )

    @dp.message(Command("rop_status"))
    async def cmd_rop_status(message: Message) -> None:
        if not _is_owner(message):
            return

        def _snapshot() -> dict:
            from apps.rop_agent.models import ROPState
            s = ROPState.get_solo()
            return {
                "muted_until": s.muted_until.isoformat() if s.muted_until else None,
                "last_briefing_at": s.last_briefing_at.isoformat() if s.last_briefing_at else None,
                "last_pulse_at": s.last_pulse_at.isoformat() if s.last_pulse_at else None,
                "last_evening_at": s.last_evening_at.isoformat() if s.last_evening_at else None,
                "last_weekly_at": s.last_weekly_at.isoformat() if s.last_weekly_at else None,
            }

        snap = await sync_to_async(_snapshot)()
        lines = ["📊 <b>ROP status</b>"]
        for k, v in snap.items():
            lines.append(f"• <code>{k}</code>: {v or '—'}")
        await message.reply("\n".join(lines), parse_mode="HTML")

    @dp.message(Command("rop_natija"))
    async def cmd_rop_natija(message: Message) -> None:
        if not _is_owner(message):
            return
        from apps.rop_agent import selectors

        kpi = await sync_to_async(selectors.midday_kpi_snapshot)()
        r = kpi.get("range", {})
        silent = kpi.get("silent_operators") or []
        follow = kpi.get("followup_today") or {}
        text = (
            "📈 <b>Hozirgi natija</b> (bugun 00:00 dan)\n"
            f"Leads: <b>{r.get('leads_created', 0)}</b> | "
            f"Contact: <b>{r.get('leads_contacted', 0)}</b> | "
            f"Sale: <b>{r.get('sales_count', 0)}</b>\n"
            f"Conv: <b>{r.get('conv', 0) * 100:.1f}%</b> | "
            f"Revenue: <b>{r.get('sales_amount', 0):,.0f} so'm</b>\n"
            f"Follow-up: {follow.get('done', 0)}/{follow.get('total', 0)}\n"
            f"Sukut operatorlar: <b>{len(silent)}</b>"
        )
        await message.reply(text, parse_mode="HTML")

    @dp.message(Command("rop_brifing"))
    async def cmd_rop_brifing(message: Message) -> None:
        if not _is_owner(message):
            return
        await message.reply("⏳ Brifing tayyorlanyapti…")
        result = await sync_to_async(rop_services.run_morning_briefing)(force=True)
        if result.get("skipped"):
            await message.reply(f"⚠️ Skipped: <code>{result['skipped']}</code>", parse_mode="HTML")
        else:
            await message.reply(
                f"✅ Yuborildi (tg_message_id={result.get('tg_message_id', '—')})",
                parse_mode="HTML",
            )

    @dp.message(Command("rop_sukut"))
    async def cmd_rop_sukut(message: Message, command: CommandObject) -> None:
        if not _is_owner(message):
            return
        arg = (command.args or "").strip()
        try:
            hours = int(arg) if arg else 2
        except ValueError:
            await message.reply("Format: /rop_sukut [N] — N soat (butun son)")
            return
        if hours <= 0:
            await sync_to_async(rop_services.unmute)()
            await message.reply("▶️ ROP agent uyg'otildi — sukut yo'q")
            return
        muted_until = await sync_to_async(rop_services.mute)(timedelta(hours=hours))
        await message.reply(
            f"⏸ Sukut: <b>{hours}h</b> (gacha {muted_until:%Y-%m-%d %H:%M} UTC)",
            parse_mode="HTML",
        )

    logger.info("ROP agent handlers registered (callbacks + 5 owner commands)")

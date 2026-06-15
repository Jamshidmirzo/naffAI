"""
Step-by-step bilingual (RU / UZ) Telegram bot for adding sales.

Conversation:
  /start | /new
    → model → IMEI → amount (total)
    → pick operator → [Весь объём / Toʻliq summa] | [Поделить / Boʻlish]
    → pick partner → same split fan-out
    → date (today / yesterday / day-before / custom)
    → comment (or '-' to skip)
    → preview → ✅ Save / ❌ Cancel

Daily report broadcast at TELEGRAM_REPORT_HOUR (default 21:00 Tashkent)
to every chat that ran /subscribe.

Language: per-chat, switched via /language. Defaults to Russian. Stored
on the same `BotSubscription` row that holds the daily-report flag.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import logging
import os
import re
from decimal import Decimal, InvalidOperation

import django

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings.prod")
django.setup()

from django.conf import settings  # noqa: E402
from django.utils import timezone  # noqa: E402

from apps.tg_bot.i18n import SUPPORTED_LANGUAGES, t  # noqa: E402
from apps.tg_bot.reports import build_daily_report  # noqa: E402

logger = logging.getLogger("tg_bot")

DAILY_REPORT_HOUR = int(os.getenv("TELEGRAM_REPORT_HOUR", "21"))


DATE_CALLBACK_PREFIX = "date:"
OP_CALLBACK_PREFIX = "op:"
PARTNER_CALLBACK_PREFIX = "partner:"
LANG_CALLBACK_PREFIX = "lang:"


def _get_lang_sync(chat_id: int) -> str:
    from apps.tg_bot.models import BotSubscription

    row = BotSubscription.objects.filter(chat_id=chat_id).values("language").first()
    return row["language"] if row else "ru"


def _upsert_chat_sync(chat_id: int, chat_title: str = "", lang: str | None = None) -> str:
    from apps.tg_bot.models import BotSubscription

    obj, _ = BotSubscription.objects.get_or_create(
        chat_id=chat_id,
        defaults={"chat_title": chat_title[:128], "is_active": False, "language": "ru"},
    )
    changed = False
    if chat_title and not obj.chat_title:
        obj.chat_title = chat_title[:128]
        changed = True
    if lang and lang in SUPPORTED_LANGUAGES and obj.language != lang:
        obj.language = lang
        changed = True
    if changed:
        obj.save(update_fields=["chat_title", "language", "updated_at"])
    return obj.language


async def main() -> None:
    try:
        from aiogram import Bot, Dispatcher, F
        from aiogram.filters import Command, CommandStart
        from aiogram.fsm.context import FSMContext
        from aiogram.fsm.state import State, StatesGroup
        from aiogram.fsm.storage.memory import MemoryStorage
        from aiogram.types import (
            BotCommand,
            CallbackQuery,
            InlineKeyboardButton,
            InlineKeyboardMarkup,
            Message,
        )
    except ImportError:
        logger.error("aiogram not installed — install with `uv pip install aiogram`")
        return

    token = settings.TELEGRAM_BOT_TOKEN
    if not token:
        logger.warning("TELEGRAM_BOT_TOKEN is empty — refusing to start.")
        return

    class NewSale(StatesGroup):
        model = State()
        imei = State()
        amount = State()
        operator_pick = State()
        operator_split_choice = State()
        operator_split_amount = State()
        partner_pick = State()
        partner_split_choice = State()
        partner_split_amount = State()
        date = State()
        comment = State()
        confirming = State()

    bot = Bot(token=token)
    dp = Dispatcher(storage=MemoryStorage())

    # ---------- helpers ----------

    async def lang_for(msg_or_cb) -> str:
        chat = msg_or_cb.message.chat if isinstance(msg_or_cb, CallbackQuery) else msg_or_cb.chat
        title = chat.title or getattr(chat, "full_name", None) or ""
        return await asyncio.to_thread(_upsert_chat_sync, chat.id, title)

    def parse_amount(text: str) -> Decimal | None:
        digits = re.sub(r"[^\d]", "", text or "")
        if not digits:
            return None
        try:
            v = Decimal(digits)
        except InvalidOperation:
            return None
        return v if v > 0 else None

    async def fetch_operators() -> list[tuple[int, str]]:
        from apps.operators.models import Operator, OperatorStatus

        def _q():
            return list(
                Operator.objects.exclude(status=OperatorStatus.INACTIVE)
                .order_by("full_name")
                .values_list("id", "full_name")[:16]
            )

        return await asyncio.to_thread(_q)

    async def fetch_partners() -> list[tuple[int, str]]:
        from apps.catalog.models import Channel

        def _q():
            return list(
                Channel.objects.filter(is_active=True)
                .order_by("name")
                .values_list("id", "name")[:16]
            )

        return await asyncio.to_thread(_q)

    def fmt_money(value, lang: str) -> str:
        try:
            num = f"{int(Decimal(str(value))):,}".replace(",", " ")
        except (InvalidOperation, TypeError, ValueError):
            return str(value)
        return f"{num} {t('rep_currency', lang)}"

    def operator_kb(ops: list[tuple[int, str]], picked_ids: set[int], lang: str) -> InlineKeyboardMarkup:
        rows = []
        available = [(oid, name) for oid, name in ops if oid not in picked_ids]
        for i in range(0, len(available), 2):
            chunk = available[i : i + 2]
            rows.append(
                [InlineKeyboardButton(text=name, callback_data=f"{OP_CALLBACK_PREFIX}{oid}") for oid, name in chunk]
            )
        rows.append([InlineKeyboardButton(text=t("btn_type_op", lang), callback_data=f"{OP_CALLBACK_PREFIX}new")])
        return InlineKeyboardMarkup(inline_keyboard=rows)

    def partner_kb(partners: list[tuple[int, str]], picked_ids: set[int], lang: str) -> InlineKeyboardMarkup:
        rows = []
        available = [(pid, name) for pid, name in partners if pid not in picked_ids]
        for i in range(0, len(available), 2):
            chunk = available[i : i + 2]
            rows.append(
                [InlineKeyboardButton(text=name, callback_data=f"{PARTNER_CALLBACK_PREFIX}{pid}") for pid, name in chunk]
            )
        rows.append([InlineKeyboardButton(text=t("btn_type_partner", lang), callback_data=f"{PARTNER_CALLBACK_PREFIX}new")])
        return InlineKeyboardMarkup(inline_keyboard=rows)

    def split_choice_kb(role: str, total_label: str, lang: str) -> InlineKeyboardMarkup:
        return InlineKeyboardMarkup(
            inline_keyboard=[
                [InlineKeyboardButton(text=t("btn_take_all", lang, label=total_label), callback_data=f"{role}-split:all")],
                [InlineKeyboardButton(text=t("btn_split", lang), callback_data=f"{role}-split:split")],
            ]
        )

    def date_kb(lang: str) -> InlineKeyboardMarkup:
        today = timezone.localdate()
        yest = today - dt.timedelta(days=1)
        dby = today - dt.timedelta(days=2)
        return InlineKeyboardMarkup(
            inline_keyboard=[
                [
                    InlineKeyboardButton(
                        text=t("btn_today", lang, d=today.strftime("%d.%m")),
                        callback_data=f"{DATE_CALLBACK_PREFIX}{today.isoformat()}",
                    ),
                    InlineKeyboardButton(
                        text=t("btn_yesterday", lang, d=yest.strftime("%d.%m")),
                        callback_data=f"{DATE_CALLBACK_PREFIX}{yest.isoformat()}",
                    ),
                ],
                [
                    InlineKeyboardButton(
                        text=t("btn_day_before", lang, d=dby.strftime("%d.%m")),
                        callback_data=f"{DATE_CALLBACK_PREFIX}{dby.isoformat()}",
                    ),
                    InlineKeyboardButton(
                        text=t("btn_custom_date", lang),
                        callback_data=f"{DATE_CALLBACK_PREFIX}custom",
                    ),
                ],
            ]
        )

    def confirm_kb(lang: str) -> InlineKeyboardMarkup:
        return InlineKeyboardMarkup(
            inline_keyboard=[
                [
                    InlineKeyboardButton(text=t("btn_save", lang), callback_data="confirm:yes"),
                    InlineKeyboardButton(text=t("btn_cancel", lang), callback_data="confirm:no"),
                ]
            ]
        )

    def language_kb() -> InlineKeyboardMarkup:
        return InlineKeyboardMarkup(
            inline_keyboard=[
                [
                    InlineKeyboardButton(text=t("btn_ru", "ru"), callback_data=f"{LANG_CALLBACK_PREFIX}ru"),
                    InlineKeyboardButton(text=t("btn_uz", "uz"), callback_data=f"{LANG_CALLBACK_PREFIX}uz"),
                ]
            ]
        )

    def _allocated(lines: list[dict]) -> Decimal:
        total = Decimal(0)
        for line in lines:
            amt = line.get("amount")
            if amt is not None:
                total += Decimal(str(amt))
        return total

    def _line_label(line: dict) -> str:
        return line.get("label") or "?"

    def _lines_summary(lines: list[dict], lang: str) -> str:
        return "\n".join(
            f"  • {_line_label(line)}: {fmt_money(line.get('amount') or 0, lang)}"
            for line in lines
            if line.get("amount") is not None
        )

    async def _ask_operator_picker(target_msg: Message, state: FSMContext, lang: str) -> None:
        ops = await fetch_operators()
        if not ops:
            await target_msg.answer(t("no_operators", lang))
            await state.clear()
            return
        data = await state.get_data()
        picked_ids = {o.get("operator_id") for o in data.get("op_lines", []) if o.get("operator_id")}
        await target_msg.answer(t("ask_operator", lang), reply_markup=operator_kb(ops, picked_ids, lang))
        await state.set_state(NewSale.operator_pick)

    async def _ask_partner_picker(target_msg: Message, state: FSMContext, lang: str) -> None:
        partners = await fetch_partners()
        if not partners:
            await target_msg.answer(t("no_partners", lang))
            await state.clear()
            return
        data = await state.get_data()
        picked_ids = {p.get("partner_id") for p in data.get("partner_lines", []) if p.get("partner_id")}
        await target_msg.answer(t("ask_partner", lang), reply_markup=partner_kb(partners, picked_ids, lang))
        await state.set_state(NewSale.partner_pick)

    async def _ask_date(target_msg: Message, state: FSMContext, lang: str) -> None:
        await target_msg.answer(t("ask_date", lang), reply_markup=date_kb(lang))
        await state.set_state(NewSale.date)

    async def _ask_comment(target_msg: Message, state: FSMContext, lang: str) -> None:
        await target_msg.answer(t("ask_comment", lang), parse_mode="Markdown")
        await state.set_state(NewSale.comment)

    async def show_preview(target: Message, data: dict, lang: str) -> None:
        dash = t("preview_dash", lang)
        text = "\n".join(
            [
                t("preview_header", lang),
                "",
                t("preview_model", lang, x=data["model"]),
                t("preview_imei", lang, x=data["imei"]),
                t("preview_amount", lang, x=fmt_money(data["amount"], lang)),
                "",
                t("preview_operators", lang),
                _lines_summary(data.get("op_lines", []), lang) or f"  {dash}",
                "",
                t("preview_partners", lang),
                _lines_summary(data.get("partner_lines", []), lang) or f"  {dash}",
                "",
                t("preview_date", lang, x=data["date_iso"]),
                t("preview_comment", lang, x=data.get("comment") or dash),
            ]
        )
        await target.answer(text, parse_mode="Markdown", reply_markup=confirm_kb(lang))

    # ---------- handlers ----------

    @dp.message(CommandStart())
    @dp.message(Command("new"))
    async def cmd_start(msg: Message, state: FSMContext) -> None:
        lang = await lang_for(msg)
        await state.clear()
        await msg.answer(t("intro", lang), parse_mode="Markdown")
        await state.set_state(NewSale.model)

    @dp.message(Command("cancel"))
    async def cmd_cancel(msg: Message, state: FSMContext) -> None:
        lang = await lang_for(msg)
        cur = await state.get_state()
        if cur is None:
            await msg.answer(t("cancel_nothing", lang))
            return
        await state.clear()
        await msg.answer(t("cancel_done", lang))

    @dp.message(Command("language"))
    async def cmd_language(msg: Message) -> None:
        # No FSM state: language can be changed any time
        lang = await lang_for(msg)
        await msg.answer(t("ask_language", lang), reply_markup=language_kb())

    @dp.callback_query(F.data.startswith(LANG_CALLBACK_PREFIX))
    async def cb_language(cb: CallbackQuery) -> None:
        choice = cb.data.removeprefix(LANG_CALLBACK_PREFIX)
        if choice not in SUPPORTED_LANGUAGES:
            await cb.answer()
            return
        await asyncio.to_thread(_upsert_chat_sync, cb.message.chat.id, "", choice)
        await cb.message.answer(t("lang_set", choice))
        await cb.answer()

    @dp.message(Command("subscribe"))
    async def cmd_subscribe(msg: Message) -> None:
        from apps.tg_bot.models import BotSubscription

        lang = await lang_for(msg)

        def _sub():
            obj, _ = BotSubscription.objects.get_or_create(chat_id=msg.chat.id)
            already = obj.is_active
            obj.is_active = True
            if msg.chat.title or getattr(msg.chat, "full_name", None):
                obj.chat_title = (msg.chat.title or msg.chat.full_name or "")[:128]
            obj.save(update_fields=["is_active", "chat_title", "updated_at"])
            return not already

        newly = await asyncio.to_thread(_sub)
        if newly:
            await msg.answer(t("sub_ok", lang, hour=DAILY_REPORT_HOUR), parse_mode="Markdown")
        else:
            await msg.answer(t("sub_already", lang))

    @dp.message(Command("unsubscribe"))
    async def cmd_unsubscribe(msg: Message) -> None:
        from apps.tg_bot.models import BotSubscription

        lang = await lang_for(msg)

        def _unsub():
            return BotSubscription.objects.filter(chat_id=msg.chat.id).update(is_active=False)

        n = await asyncio.to_thread(_unsub)
        await msg.answer(t("unsub_ok" if n else "unsub_none", lang))

    @dp.message(Command("report"))
    async def cmd_report(msg: Message) -> None:
        lang = await lang_for(msg)
        text = await asyncio.to_thread(build_daily_report, None, lang)
        await msg.answer(text, parse_mode="Markdown")

    @dp.message(NewSale.model)
    async def step_model(msg: Message, state: FSMContext) -> None:
        lang = await lang_for(msg)
        text = (msg.text or "").strip()
        if not text:
            await msg.answer(t("model_empty", lang))
            return
        await state.update_data(model=text)
        await msg.answer(t("ask_imei", lang), parse_mode="Markdown")
        await state.set_state(NewSale.imei)

    @dp.message(NewSale.imei)
    async def step_imei(msg: Message, state: FSMContext) -> None:
        lang = await lang_for(msg)
        digits = re.sub(r"\D", "", msg.text or "")
        if not (6 <= len(digits) <= 15):
            await msg.answer(t("imei_bad", lang))
            return
        await state.update_data(imei=digits)
        await msg.answer(t("ask_amount", lang), parse_mode="Markdown")
        await state.set_state(NewSale.amount)

    @dp.message(NewSale.amount)
    async def step_amount(msg: Message, state: FSMContext) -> None:
        lang = await lang_for(msg)
        amt = parse_amount(msg.text or "")
        if amt is None or amt < 1000:
            await msg.answer(t("amount_bad", lang))
            return
        await state.update_data(amount=str(amt), op_lines=[], partner_lines=[])
        await _ask_operator_picker(msg, state, lang)

    async def _after_operator_picked(target_msg: Message, state: FSMContext, lang: str) -> None:
        data = await state.get_data()
        op_lines = data.get("op_lines", [])
        total = Decimal(data["amount"])
        allocated = _allocated(op_lines[:-1])
        remaining = total - allocated

        if len(op_lines) == 1:
            label = fmt_money(remaining, lang)
            await target_msg.answer(
                t("ask_op_split", lang, label=op_lines[-1]["label"]),
                parse_mode="Markdown",
                reply_markup=split_choice_kb("op", label, lang),
            )
            await state.set_state(NewSale.operator_split_choice)
        else:
            await target_msg.answer(
                t("ask_op_amount_rem", lang, label=op_lines[-1]["label"], rem=fmt_money(remaining, lang)),
                parse_mode="Markdown",
            )
            await state.set_state(NewSale.operator_split_amount)

    @dp.callback_query(F.data.startswith(OP_CALLBACK_PREFIX), NewSale.operator_pick)
    async def cb_operator(cb: CallbackQuery, state: FSMContext) -> None:
        lang = await lang_for(cb)
        payload = cb.data.removeprefix(OP_CALLBACK_PREFIX)
        if payload == "new":
            await cb.message.answer(t("type_operator_name", lang))
            await cb.answer()
            return

        from apps.operators.models import Operator

        def _g():
            return Operator.objects.filter(pk=int(payload)).values("id", "full_name").first()

        row = await asyncio.to_thread(_g)
        if not row:
            await cb.answer(t("operator_not_found", lang), show_alert=True)
            return

        data = await state.get_data()
        op_lines = data.get("op_lines", [])
        op_lines.append({"operator_id": row["id"], "label": row["full_name"], "amount": None})
        await state.update_data(op_lines=op_lines)
        await _after_operator_picked(cb.message, state, lang)
        await cb.answer()

    @dp.message(NewSale.operator_pick)
    async def step_operator_name(msg: Message, state: FSMContext) -> None:
        lang = await lang_for(msg)
        name = (msg.text or "").strip()
        if not name:
            await msg.answer(t("name_empty", lang))
            return
        data = await state.get_data()
        op_lines = data.get("op_lines", [])
        op_lines.append({"operator_name": name, "label": name, "amount": None})
        await state.update_data(op_lines=op_lines)
        await _after_operator_picked(msg, state, lang)

    @dp.callback_query(F.data == "op-split:all", NewSale.operator_split_choice)
    async def cb_op_take_all(cb: CallbackQuery, state: FSMContext) -> None:
        lang = await lang_for(cb)
        data = await state.get_data()
        op_lines = data.get("op_lines", [])
        total = Decimal(data["amount"])
        op_lines[-1]["amount"] = str(total - _allocated(op_lines[:-1]))
        await state.update_data(op_lines=op_lines)
        await cb.answer(t("saved_one_op", lang))
        await _ask_partner_picker(cb.message, state, lang)

    @dp.callback_query(F.data == "op-split:split", NewSale.operator_split_choice)
    async def cb_op_split(cb: CallbackQuery, state: FSMContext) -> None:
        lang = await lang_for(cb)
        data = await state.get_data()
        op_lines = data.get("op_lines", [])
        await cb.message.answer(
            t("ask_op_amount_type", lang, label=op_lines[-1]["label"]), parse_mode="Markdown"
        )
        await state.set_state(NewSale.operator_split_amount)
        await cb.answer()

    @dp.message(NewSale.operator_split_choice)
    async def step_op_split_choice_text(msg: Message, state: FSMContext) -> None:
        await state.set_state(NewSale.operator_split_amount)
        await step_operator_amount(msg, state)

    @dp.message(NewSale.operator_split_amount)
    async def step_operator_amount(msg: Message, state: FSMContext) -> None:
        lang = await lang_for(msg)
        amt = parse_amount(msg.text or "")
        if amt is None or amt < 1000:
            await msg.answer(t("amount_bad", lang))
            return
        data = await state.get_data()
        op_lines = data.get("op_lines", [])
        total = Decimal(data["amount"])
        allocated_before = _allocated(op_lines[:-1])
        max_for_current = total - allocated_before
        if amt > max_for_current:
            await msg.answer(t("amount_too_big", lang, rem=fmt_money(max_for_current, lang)), parse_mode="Markdown")
            return
        op_lines[-1]["amount"] = str(amt)
        await state.update_data(op_lines=op_lines)
        new_rem = total - _allocated(op_lines)
        if new_rem == 0:
            await msg.answer(t("ops_done", lang, summary=_lines_summary(op_lines, lang)), parse_mode="Markdown")
            await _ask_partner_picker(msg, state, lang)
        else:
            await msg.answer(t("remaining_to_whom", lang, rem=fmt_money(new_rem, lang)), parse_mode="Markdown")
            await _ask_operator_picker(msg, state, lang)

    async def _after_partner_picked(target_msg: Message, state: FSMContext, lang: str) -> None:
        data = await state.get_data()
        partner_lines = data.get("partner_lines", [])
        total = Decimal(data["amount"])
        remaining = total - _allocated(partner_lines[:-1])

        if len(partner_lines) == 1:
            label = fmt_money(remaining, lang)
            await target_msg.answer(
                t("ask_partner_split", lang, label=partner_lines[-1]["label"]),
                parse_mode="Markdown",
                reply_markup=split_choice_kb("partner", label, lang),
            )
            await state.set_state(NewSale.partner_split_choice)
        else:
            await target_msg.answer(
                t("ask_partner_amount_rem", lang, label=partner_lines[-1]["label"], rem=fmt_money(remaining, lang)),
                parse_mode="Markdown",
            )
            await state.set_state(NewSale.partner_split_amount)

    @dp.callback_query(F.data.startswith(PARTNER_CALLBACK_PREFIX), NewSale.partner_pick)
    async def cb_partner(cb: CallbackQuery, state: FSMContext) -> None:
        lang = await lang_for(cb)
        payload = cb.data.removeprefix(PARTNER_CALLBACK_PREFIX)
        if payload == "new":
            await cb.message.answer(t("type_partner_name", lang))
            await cb.answer()
            return

        from apps.catalog.models import Channel

        def _g():
            return Channel.objects.filter(pk=int(payload)).values("id", "name").first()

        row = await asyncio.to_thread(_g)
        if not row:
            await cb.answer(t("partner_not_found", lang), show_alert=True)
            return

        data = await state.get_data()
        partner_lines = data.get("partner_lines", [])
        partner_lines.append({"partner_id": row["id"], "label": row["name"], "amount": None})
        await state.update_data(partner_lines=partner_lines)
        await _after_partner_picked(cb.message, state, lang)
        await cb.answer()

    @dp.message(NewSale.partner_pick)
    async def step_partner_name(msg: Message, state: FSMContext) -> None:
        lang = await lang_for(msg)
        name = (msg.text or "").strip()
        if not name:
            await msg.answer(t("name_empty", lang))
            return
        data = await state.get_data()
        partner_lines = data.get("partner_lines", [])
        partner_lines.append({"partner_name": name, "label": name, "amount": None})
        await state.update_data(partner_lines=partner_lines)
        await _after_partner_picked(msg, state, lang)

    @dp.callback_query(F.data == "partner-split:all", NewSale.partner_split_choice)
    async def cb_partner_take_all(cb: CallbackQuery, state: FSMContext) -> None:
        lang = await lang_for(cb)
        data = await state.get_data()
        partner_lines = data.get("partner_lines", [])
        total = Decimal(data["amount"])
        partner_lines[-1]["amount"] = str(total - _allocated(partner_lines[:-1]))
        await state.update_data(partner_lines=partner_lines)
        await cb.answer(t("saved_one_op", lang))
        await _ask_date(cb.message, state, lang)

    @dp.callback_query(F.data == "partner-split:split", NewSale.partner_split_choice)
    async def cb_partner_split(cb: CallbackQuery, state: FSMContext) -> None:
        lang = await lang_for(cb)
        data = await state.get_data()
        partner_lines = data.get("partner_lines", [])
        await cb.message.answer(
            t("ask_partner_amount_type", lang, label=partner_lines[-1]["label"]), parse_mode="Markdown"
        )
        await state.set_state(NewSale.partner_split_amount)
        await cb.answer()

    @dp.message(NewSale.partner_split_choice)
    async def step_partner_split_choice_text(msg: Message, state: FSMContext) -> None:
        await state.set_state(NewSale.partner_split_amount)
        await step_partner_amount(msg, state)

    @dp.message(NewSale.partner_split_amount)
    async def step_partner_amount(msg: Message, state: FSMContext) -> None:
        lang = await lang_for(msg)
        amt = parse_amount(msg.text or "")
        if amt is None or amt < 1000:
            await msg.answer(t("amount_bad", lang))
            return
        data = await state.get_data()
        partner_lines = data.get("partner_lines", [])
        total = Decimal(data["amount"])
        allocated_before = _allocated(partner_lines[:-1])
        max_for_current = total - allocated_before
        if amt > max_for_current:
            await msg.answer(t("amount_too_big", lang, rem=fmt_money(max_for_current, lang)), parse_mode="Markdown")
            return
        partner_lines[-1]["amount"] = str(amt)
        await state.update_data(partner_lines=partner_lines)
        new_rem = total - _allocated(partner_lines)
        if new_rem == 0:
            await msg.answer(t("partners_done", lang, summary=_lines_summary(partner_lines, lang)), parse_mode="Markdown")
            await _ask_date(msg, state, lang)
        else:
            await msg.answer(t("remaining_via_whom", lang, rem=fmt_money(new_rem, lang)), parse_mode="Markdown")
            await _ask_partner_picker(msg, state, lang)

    @dp.callback_query(F.data.startswith(DATE_CALLBACK_PREFIX), NewSale.date)
    async def cb_date(cb: CallbackQuery, state: FSMContext) -> None:
        lang = await lang_for(cb)
        payload = cb.data.removeprefix(DATE_CALLBACK_PREFIX)
        if payload == "custom":
            await cb.message.answer(t("ask_date_text", lang), parse_mode="Markdown")
        else:
            await state.update_data(date_iso=payload)
            await _ask_comment(cb.message, state, lang)
        await cb.answer()

    @dp.message(NewSale.date)
    async def step_date_text(msg: Message, state: FSMContext) -> None:
        lang = await lang_for(msg)
        text = (msg.text or "").strip()
        try:
            d = dt.date.fromisoformat(text)
        except ValueError:
            await msg.answer(t("date_bad", lang), parse_mode="Markdown")
            return
        await state.update_data(date_iso=d.isoformat())
        await _ask_comment(msg, state, lang)

    @dp.message(NewSale.comment)
    async def step_comment(msg: Message, state: FSMContext) -> None:
        lang = await lang_for(msg)
        text = (msg.text or "").strip()
        if text == "-":
            text = ""
        await state.update_data(comment=text)
        data = await state.get_data()
        await show_preview(msg, data, lang)
        await state.set_state(NewSale.confirming)

    @dp.callback_query(F.data == "confirm:no", NewSale.confirming)
    async def cb_cancel_confirm(cb: CallbackQuery, state: FSMContext) -> None:
        lang = await lang_for(cb)
        await state.clear()
        await cb.message.answer(t("cancel_confirm", lang))
        await cb.answer()

    @dp.callback_query(F.data == "confirm:yes", NewSale.confirming)
    async def cb_save(cb: CallbackQuery, state: FSMContext) -> None:
        lang = await lang_for(cb)
        data = await state.get_data()
        await cb.answer(t("saving", lang))
        try:
            sale = await asyncio.to_thread(_create_sale, data)
        except Exception as exc:  # noqa: BLE001
            logger.exception("sale create failed")
            await cb.message.answer(t("save_fail", lang, exc=exc), parse_mode="Markdown")
            return
        await cb.message.answer(t("save_ok", lang, id=sale.id), parse_mode="Markdown")
        await state.clear()

    async def daily_report_scheduler() -> None:
        while True:
            now = timezone.localtime()
            target = now.replace(hour=DAILY_REPORT_HOUR, minute=0, second=0, microsecond=0)
            if target <= now:
                target = target + dt.timedelta(days=1)
            delay = (target - now).total_seconds()
            logger.info("Next daily report at %s (in %.0f s)", target, delay)
            try:
                await asyncio.sleep(delay)
            except asyncio.CancelledError:
                return

            from apps.tg_bot.models import BotSubscription

            def _subs():
                return list(
                    BotSubscription.objects.filter(is_active=True).values_list("chat_id", "language")
                )

            try:
                rows = await asyncio.to_thread(_subs)
            except Exception:  # noqa: BLE001
                logger.exception("loading subscriptions failed")
                continue

            # Build report once per language so we don't aggregate N times for N subscribers.
            cache: dict[str, str] = {}
            for chat_id, lang in rows:
                if lang not in cache:
                    try:
                        cache[lang] = await asyncio.to_thread(build_daily_report, None, lang)
                    except Exception:  # noqa: BLE001
                        logger.exception("daily report build failed for lang=%s", lang)
                        cache[lang] = "report-build-failed"
                try:
                    await bot.send_message(chat_id, cache[lang], parse_mode="Markdown")
                except Exception:  # noqa: BLE001
                    logger.exception("send_message to %s failed", chat_id)

    # Slash-menu — Telegram caches per language, so we register for both.
    common = [
        ("new", "cmd_new"),
        ("report", "cmd_report"),
        ("subscribe", "cmd_subscribe"),
        ("unsubscribe", "cmd_unsubscribe"),
        ("language", "cmd_language"),
        ("cancel", "cmd_cancel"),
        ("start", "cmd_start"),
    ]
    from aiogram.types import BotCommandScopeAllPrivateChats

    for lang in SUPPORTED_LANGUAGES:
        await bot.set_my_commands(
            [BotCommand(command=name, description=t(key, lang)) for name, key in common],
            scope=BotCommandScopeAllPrivateChats(),
            language_code=lang,
        )
    # Fallback list (no language_code) — used by Telegram clients we don't recognise.
    await bot.set_my_commands(
        [BotCommand(command=name, description=t(key, "ru")) for name, key in common],
    )

    logger.info("Bot started — polling…")
    asyncio.create_task(daily_report_scheduler())
    await dp.start_polling(bot)


def _create_sale(data: dict):
    from apps.sales.services import sale_create

    tz = timezone.get_current_timezone()
    sold_at = dt.datetime.fromisoformat(data["date_iso"]).replace(hour=12, tzinfo=tz)

    op_payload = []
    for line in data["op_lines"]:
        item = {"amount": str(line["amount"])}
        if line.get("operator_id"):
            item["operator_id"] = line["operator_id"]
        else:
            item["operator_name"] = line["operator_name"]
        op_payload.append(item)

    partner_payload = []
    for line in data["partner_lines"]:
        item = {"amount": str(line["amount"])}
        if line.get("partner_id"):
            item["partner_id"] = line["partner_id"]
        else:
            item["partner_name"] = line["partner_name"]
        partner_payload.append(item)

    return sale_create(
        imei=data["imei"],
        phone_model=data["model"],
        operators=op_payload,
        partners=partner_payload,
        comment=data.get("comment", ""),
        sold_at=sold_at,
        allow_duplicate_imei=True,
        duplicate_override_comment="из Telegram-бота",
    )


if __name__ == "__main__":
    asyncio.run(main())

"""
Step-by-step Telegram bot for adding sales (multi-allocation aware).

Conversation:
  /start | /new
    → model → IMEI → amount (total)
    → pick operator → [Этому весь объём] | [Добавить ещё]
        if split: type amount → pick next operator → amount → loop
    → pick partner → same fan-out as operator
    → date (today / yesterday / day-before / custom)
    → comment (or '-' to skip)
    → preview → ✅ Save / ❌ Cancel

State per chat is kept in MemoryStorage. On confirm we call the same
`sale_create` service the web API uses so audit log + allocation lines
land in the canonical place.

Run via `docker compose --profile bot up bot` after setting
TELEGRAM_BOT_TOKEN in `.env`.
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

logger = logging.getLogger("tg_bot")


DATE_CALLBACK_PREFIX = "date:"
OP_CALLBACK_PREFIX = "op:"
PARTNER_CALLBACK_PREFIX = "partner:"


async def main() -> None:
    try:
        from aiogram import Bot, Dispatcher, F
        from aiogram.filters import Command, CommandStart
        from aiogram.fsm.context import FSMContext
        from aiogram.fsm.state import State, StatesGroup
        from aiogram.fsm.storage.memory import MemoryStorage
        from aiogram.types import (
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
        operator_pick = State()           # waiting for op (inline tap OR free-text name)
        operator_split_choice = State()   # after 1st op picked: «весь объём / поделить»
        operator_split_amount = State()   # waiting for amount text for last picked op
        partner_pick = State()
        partner_split_choice = State()
        partner_split_amount = State()
        date = State()
        comment = State()
        confirming = State()

    bot = Bot(token=token)
    dp = Dispatcher(storage=MemoryStorage())

    # ---------- helpers ----------

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

    def fmt_money(value) -> str:
        try:
            return f"{int(Decimal(str(value))):,}".replace(",", " ") + " сум"
        except (InvalidOperation, TypeError, ValueError):
            return str(value)

    def operator_kb(ops: list[tuple[int, str]], picked_ids: set[int]) -> InlineKeyboardMarkup:
        rows = []
        available = [(oid, name) for oid, name in ops if oid not in picked_ids]
        for i in range(0, len(available), 2):
            chunk = available[i : i + 2]
            rows.append(
                [
                    InlineKeyboardButton(text=name, callback_data=f"{OP_CALLBACK_PREFIX}{oid}")
                    for oid, name in chunk
                ]
            )
        rows.append(
            [InlineKeyboardButton(text="✏️ Ввести имя", callback_data=f"{OP_CALLBACK_PREFIX}new")]
        )
        return InlineKeyboardMarkup(inline_keyboard=rows)

    def partner_kb(partners: list[tuple[int, str]], picked_ids: set[int]) -> InlineKeyboardMarkup:
        rows = []
        available = [(pid, name) for pid, name in partners if pid not in picked_ids]
        for i in range(0, len(available), 2):
            chunk = available[i : i + 2]
            rows.append(
                [
                    InlineKeyboardButton(
                        text=name, callback_data=f"{PARTNER_CALLBACK_PREFIX}{pid}"
                    )
                    for pid, name in chunk
                ]
            )
        rows.append(
            [
                InlineKeyboardButton(
                    text="✏️ Ввести название", callback_data=f"{PARTNER_CALLBACK_PREFIX}new"
                )
            ]
        )
        return InlineKeyboardMarkup(inline_keyboard=rows)

    def split_choice_kb(role: str, total_label: str) -> InlineKeyboardMarkup:
        """role: 'op' | 'partner'"""
        return InlineKeyboardMarkup(
            inline_keyboard=[
                [
                    InlineKeyboardButton(
                        text=f"✅ Весь объём ({total_label})",
                        callback_data=f"{role}-split:all",
                    )
                ],
                [
                    InlineKeyboardButton(
                        text="➕ Поделить с другим",
                        callback_data=f"{role}-split:split",
                    )
                ],
            ]
        )

    def date_kb() -> InlineKeyboardMarkup:
        today = timezone.localdate()
        yest = today - dt.timedelta(days=1)
        dby = today - dt.timedelta(days=2)
        return InlineKeyboardMarkup(
            inline_keyboard=[
                [
                    InlineKeyboardButton(
                        text=f"Сегодня · {today.strftime('%d.%m')}",
                        callback_data=f"{DATE_CALLBACK_PREFIX}{today.isoformat()}",
                    ),
                    InlineKeyboardButton(
                        text=f"Вчера · {yest.strftime('%d.%m')}",
                        callback_data=f"{DATE_CALLBACK_PREFIX}{yest.isoformat()}",
                    ),
                ],
                [
                    InlineKeyboardButton(
                        text=f"Позавчера · {dby.strftime('%d.%m')}",
                        callback_data=f"{DATE_CALLBACK_PREFIX}{dby.isoformat()}",
                    ),
                    InlineKeyboardButton(
                        text="📅 Другая дата", callback_data=f"{DATE_CALLBACK_PREFIX}custom"
                    ),
                ],
            ]
        )

    def confirm_kb() -> InlineKeyboardMarkup:
        return InlineKeyboardMarkup(
            inline_keyboard=[
                [
                    InlineKeyboardButton(text="✅ Сохранить", callback_data="confirm:yes"),
                    InlineKeyboardButton(text="❌ Отменить", callback_data="confirm:no"),
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

    def _lines_summary(lines: list[dict]) -> str:
        return "\n".join(
            f"  • {_line_label(line)}: {fmt_money(line.get('amount') or 0)}"
            for line in lines
            if line.get("amount") is not None
        )

    async def _ask_partner_picker(target_msg: Message, state: FSMContext) -> None:
        partners = await fetch_partners()
        if not partners:
            await target_msg.answer("Нет активных партнёров. Создай их в дашборде сначала.")
            await state.clear()
            return
        data = await state.get_data()
        picked_ids = {p.get("partner_id") for p in data.get("partner_lines", []) if p.get("partner_id")}
        await target_msg.answer(
            "Через какого партнёра оплата? (Alif/Birzum/Hamroh/Cash/...)",
            reply_markup=partner_kb(partners, picked_ids),
        )
        await state.set_state(NewSale.partner_pick)

    async def _ask_operator_picker(target_msg: Message, state: FSMContext) -> None:
        ops = await fetch_operators()
        if not ops:
            await target_msg.answer("Нет активных операторов. Создай их в дашборде сначала.")
            await state.clear()
            return
        data = await state.get_data()
        picked_ids = {o.get("operator_id") for o in data.get("op_lines", []) if o.get("operator_id")}
        await target_msg.answer(
            "Кто продал? Выбери из списка или впиши имя.",
            reply_markup=operator_kb(ops, picked_ids),
        )
        await state.set_state(NewSale.operator_pick)

    async def _ask_date(target_msg: Message, state: FSMContext) -> None:
        await target_msg.answer("Какая дата продажи?", reply_markup=date_kb())
        await state.set_state(NewSale.date)

    async def _ask_comment(target_msg: Message, state: FSMContext) -> None:
        await target_msg.answer(
            "Комментарий? Напиши текст или `-` чтобы пропустить.",
            parse_mode="Markdown",
        )
        await state.set_state(NewSale.comment)

    async def show_preview(target: Message, data: dict) -> None:
        op_summary = _lines_summary(data.get("op_lines", []))
        partner_summary = _lines_summary(data.get("partner_lines", []))
        text = (
            "📋 *Проверь продажу:*\n\n"
            f"📱 *Модель:* {data['model']}\n"
            f"🔢 *IMEI:* `{data['imei']}`\n"
            f"💰 *Сумма:* {fmt_money(data['amount'])}\n\n"
            f"👤 *Операторы:*\n{op_summary}\n\n"
            f"🤝 *Партнёры:*\n{partner_summary}\n\n"
            f"📅 *Дата:* {data['date_iso']}\n"
            f"📝 *Комментарий:* {data.get('comment') or '—'}\n"
        )
        await target.answer(text, parse_mode="Markdown", reply_markup=confirm_kb())

    # ---------- handlers ----------

    @dp.message(CommandStart())
    @dp.message(Command("new"))
    async def cmd_start(msg: Message, state: FSMContext) -> None:
        await state.clear()
        await msg.answer(
            "Добавляем новую продажу 🛒\n\nНапиши *модель телефона* (например: «iPhone 13 128GB»).",
            parse_mode="Markdown",
        )
        await state.set_state(NewSale.model)

    @dp.message(Command("cancel"))
    async def cmd_cancel(msg: Message, state: FSMContext) -> None:
        cur = await state.get_state()
        if cur is None:
            await msg.answer("Нечего отменять.")
            return
        await state.clear()
        await msg.answer("Отменено. /new — чтобы начать заново.")

    @dp.message(NewSale.model)
    async def step_model(msg: Message, state: FSMContext) -> None:
        text = (msg.text or "").strip()
        if not text:
            await msg.answer("Модель не может быть пустой. Напиши ещё раз.")
            return
        await state.update_data(model=text)
        await msg.answer("Теперь *IMEI* (6–15 цифр).", parse_mode="Markdown")
        await state.set_state(NewSale.imei)

    @dp.message(NewSale.imei)
    async def step_imei(msg: Message, state: FSMContext) -> None:
        digits = re.sub(r"\D", "", msg.text or "")
        if not (6 <= len(digits) <= 15):
            await msg.answer("IMEI должен быть из 6–15 цифр. Попробуй ещё раз.")
            return
        await state.update_data(imei=digits)
        await msg.answer("Сумма продажи в сумах (например: `4500000`).", parse_mode="Markdown")
        await state.set_state(NewSale.amount)

    @dp.message(NewSale.amount)
    async def step_amount(msg: Message, state: FSMContext) -> None:
        amt = parse_amount(msg.text or "")
        if amt is None or amt < 1000:
            await msg.answer("Сумма должна быть числом ≥ 1 000. Попробуй ещё раз.")
            return
        await state.update_data(amount=str(amt), op_lines=[], partner_lines=[])
        await _ask_operator_picker(msg, state)

    # ----- Operator selection -----

    async def _after_operator_picked(target_msg: Message, state: FSMContext) -> None:
        """Common code path after an operator is picked (by id OR by name)."""
        data = await state.get_data()
        op_lines = data.get("op_lines", [])
        total = Decimal(data["amount"])
        allocated = _allocated(op_lines[:-1])  # excl. the one we just picked
        remaining = total - allocated

        if not op_lines or len(op_lines) == 1:
            # First operator picked → offer "Весь объём / Поделить"
            label = fmt_money(remaining)
            await target_msg.answer(
                f"Сколько для *{op_lines[-1]['label']}*?",
                parse_mode="Markdown",
                reply_markup=split_choice_kb("op", label),
            )
            await state.set_state(NewSale.operator_split_choice)
        else:
            # 2nd+ operator: ask their amount directly (remaining shown).
            await target_msg.answer(
                f"Сколько для *{op_lines[-1]['label']}*? "
                f"Осталось распределить: *{fmt_money(remaining)}*.",
                parse_mode="Markdown",
            )
            await state.set_state(NewSale.operator_split_amount)

    @dp.callback_query(F.data.startswith(OP_CALLBACK_PREFIX), NewSale.operator_pick)
    async def cb_operator(cb: CallbackQuery, state: FSMContext) -> None:
        payload = cb.data.removeprefix(OP_CALLBACK_PREFIX)
        if payload == "new":
            await cb.message.answer("Впиши имя оператора.")
            await cb.answer()
            return

        from apps.operators.models import Operator

        def _g():
            return Operator.objects.filter(pk=int(payload)).values("id", "full_name").first()

        row = await asyncio.to_thread(_g)
        if not row:
            await cb.answer("Не нашёл оператора", show_alert=True)
            return

        data = await state.get_data()
        op_lines = data.get("op_lines", [])
        op_lines.append({"operator_id": row["id"], "label": row["full_name"], "amount": None})
        await state.update_data(op_lines=op_lines)
        await _after_operator_picked(cb.message, state)
        await cb.answer()

    @dp.message(NewSale.operator_pick)
    async def step_operator_name(msg: Message, state: FSMContext) -> None:
        name = (msg.text or "").strip()
        if not name:
            await msg.answer("Имя не может быть пустым.")
            return
        data = await state.get_data()
        op_lines = data.get("op_lines", [])
        op_lines.append({"operator_name": name, "label": name, "amount": None})
        await state.update_data(op_lines=op_lines)
        await _after_operator_picked(msg, state)

    @dp.callback_query(F.data == "op-split:all", NewSale.operator_split_choice)
    async def cb_op_take_all(cb: CallbackQuery, state: FSMContext) -> None:
        data = await state.get_data()
        op_lines = data.get("op_lines", [])
        total = Decimal(data["amount"])
        allocated = _allocated(op_lines[:-1])
        op_lines[-1]["amount"] = str(total - allocated)
        await state.update_data(op_lines=op_lines)
        await cb.answer("Записал на одного.")
        await _ask_partner_picker(cb.message, state)

    @dp.callback_query(F.data == "op-split:split", NewSale.operator_split_choice)
    async def cb_op_split(cb: CallbackQuery, state: FSMContext) -> None:
        data = await state.get_data()
        op_lines = data.get("op_lines", [])
        await cb.message.answer(
            f"Сколько для *{op_lines[-1]['label']}*? Напиши сумму.",
            parse_mode="Markdown",
        )
        await state.set_state(NewSale.operator_split_amount)
        await cb.answer()

    @dp.message(NewSale.operator_split_choice)
    async def step_operator_split_choice_text(msg: Message, state: FSMContext) -> None:
        # User typed instead of tapping — interpret as amount for current op.
        await state.set_state(NewSale.operator_split_amount)
        await step_operator_amount(msg, state)

    @dp.message(NewSale.operator_split_amount)
    async def step_operator_amount(msg: Message, state: FSMContext) -> None:
        amt = parse_amount(msg.text or "")
        if amt is None or amt < 1000:
            await msg.answer("Сумма должна быть числом ≥ 1 000. Попробуй ещё раз.")
            return
        data = await state.get_data()
        op_lines = data.get("op_lines", [])
        total = Decimal(data["amount"])
        allocated_before = _allocated(op_lines[:-1])
        max_for_current = total - allocated_before
        if amt > max_for_current:
            await msg.answer(
                f"Слишком много — осталось всего *{fmt_money(max_for_current)}*. "
                f"Попробуй ещё раз.",
                parse_mode="Markdown",
            )
            return
        op_lines[-1]["amount"] = str(amt)
        await state.update_data(op_lines=op_lines)

        new_remaining = total - _allocated(op_lines)
        if new_remaining == 0:
            await msg.answer(
                f"👤 Операторы распределены:\n{_lines_summary(op_lines)}",
                parse_mode="Markdown",
            )
            await _ask_partner_picker(msg, state)
        else:
            await msg.answer(
                f"Осталось *{fmt_money(new_remaining)}* — кому?",
                parse_mode="Markdown",
            )
            await _ask_operator_picker(msg, state)

    # ----- Partner selection (mirrors operator) -----

    async def _after_partner_picked(target_msg: Message, state: FSMContext) -> None:
        data = await state.get_data()
        partner_lines = data.get("partner_lines", [])
        total = Decimal(data["amount"])
        allocated = _allocated(partner_lines[:-1])
        remaining = total - allocated

        if not partner_lines or len(partner_lines) == 1:
            label = fmt_money(remaining)
            await target_msg.answer(
                f"Сколько через *{partner_lines[-1]['label']}*?",
                parse_mode="Markdown",
                reply_markup=split_choice_kb("partner", label),
            )
            await state.set_state(NewSale.partner_split_choice)
        else:
            await target_msg.answer(
                f"Сколько через *{partner_lines[-1]['label']}*? "
                f"Осталось распределить: *{fmt_money(remaining)}*.",
                parse_mode="Markdown",
            )
            await state.set_state(NewSale.partner_split_amount)

    @dp.callback_query(F.data.startswith(PARTNER_CALLBACK_PREFIX), NewSale.partner_pick)
    async def cb_partner(cb: CallbackQuery, state: FSMContext) -> None:
        payload = cb.data.removeprefix(PARTNER_CALLBACK_PREFIX)
        if payload == "new":
            await cb.message.answer("Впиши название партнёра.")
            await cb.answer()
            return

        from apps.catalog.models import Channel

        def _g():
            return Channel.objects.filter(pk=int(payload)).values("id", "name").first()

        row = await asyncio.to_thread(_g)
        if not row:
            await cb.answer("Не нашёл партнёра", show_alert=True)
            return

        data = await state.get_data()
        partner_lines = data.get("partner_lines", [])
        partner_lines.append({"partner_id": row["id"], "label": row["name"], "amount": None})
        await state.update_data(partner_lines=partner_lines)
        await _after_partner_picked(cb.message, state)
        await cb.answer()

    @dp.message(NewSale.partner_pick)
    async def step_partner_name(msg: Message, state: FSMContext) -> None:
        name = (msg.text or "").strip()
        if not name:
            await msg.answer("Название не может быть пустым.")
            return
        data = await state.get_data()
        partner_lines = data.get("partner_lines", [])
        partner_lines.append({"partner_name": name, "label": name, "amount": None})
        await state.update_data(partner_lines=partner_lines)
        await _after_partner_picked(msg, state)

    @dp.callback_query(F.data == "partner-split:all", NewSale.partner_split_choice)
    async def cb_partner_take_all(cb: CallbackQuery, state: FSMContext) -> None:
        data = await state.get_data()
        partner_lines = data.get("partner_lines", [])
        total = Decimal(data["amount"])
        allocated = _allocated(partner_lines[:-1])
        partner_lines[-1]["amount"] = str(total - allocated)
        await state.update_data(partner_lines=partner_lines)
        await cb.answer("Записал на одного.")
        await _ask_date(cb.message, state)

    @dp.callback_query(F.data == "partner-split:split", NewSale.partner_split_choice)
    async def cb_partner_split(cb: CallbackQuery, state: FSMContext) -> None:
        data = await state.get_data()
        partner_lines = data.get("partner_lines", [])
        await cb.message.answer(
            f"Сколько через *{partner_lines[-1]['label']}*? Напиши сумму.",
            parse_mode="Markdown",
        )
        await state.set_state(NewSale.partner_split_amount)
        await cb.answer()

    @dp.message(NewSale.partner_split_choice)
    async def step_partner_split_choice_text(msg: Message, state: FSMContext) -> None:
        await state.set_state(NewSale.partner_split_amount)
        await step_partner_amount(msg, state)

    @dp.message(NewSale.partner_split_amount)
    async def step_partner_amount(msg: Message, state: FSMContext) -> None:
        amt = parse_amount(msg.text or "")
        if amt is None or amt < 1000:
            await msg.answer("Сумма должна быть числом ≥ 1 000. Попробуй ещё раз.")
            return
        data = await state.get_data()
        partner_lines = data.get("partner_lines", [])
        total = Decimal(data["amount"])
        allocated_before = _allocated(partner_lines[:-1])
        max_for_current = total - allocated_before
        if amt > max_for_current:
            await msg.answer(
                f"Слишком много — осталось всего *{fmt_money(max_for_current)}*. "
                f"Попробуй ещё раз.",
                parse_mode="Markdown",
            )
            return
        partner_lines[-1]["amount"] = str(amt)
        await state.update_data(partner_lines=partner_lines)

        new_remaining = total - _allocated(partner_lines)
        if new_remaining == 0:
            await msg.answer(
                f"🤝 Партнёры распределены:\n{_lines_summary(partner_lines)}",
                parse_mode="Markdown",
            )
            await _ask_date(msg, state)
        else:
            await msg.answer(
                f"Осталось *{fmt_money(new_remaining)}* — через кого?",
                parse_mode="Markdown",
            )
            await _ask_partner_picker(msg, state)

    # ----- Date -----

    @dp.callback_query(F.data.startswith(DATE_CALLBACK_PREFIX), NewSale.date)
    async def cb_date(cb: CallbackQuery, state: FSMContext) -> None:
        payload = cb.data.removeprefix(DATE_CALLBACK_PREFIX)
        if payload == "custom":
            await cb.message.answer(
                "Впиши дату в формате `YYYY-MM-DD` (например `2026-06-12`).",
                parse_mode="Markdown",
            )
        else:
            await state.update_data(date_iso=payload)
            await _ask_comment(cb.message, state)
        await cb.answer()

    @dp.message(NewSale.date)
    async def step_date_text(msg: Message, state: FSMContext) -> None:
        text = (msg.text or "").strip()
        try:
            d = dt.date.fromisoformat(text)
        except ValueError:
            await msg.answer(
                "Не понял дату. Формат: `YYYY-MM-DD`, например `2026-06-12`.",
                parse_mode="Markdown",
            )
            return
        await state.update_data(date_iso=d.isoformat())
        await _ask_comment(msg, state)

    # ----- Comment + Confirm -----

    @dp.message(NewSale.comment)
    async def step_comment(msg: Message, state: FSMContext) -> None:
        text = (msg.text or "").strip()
        if text == "-":
            text = ""
        await state.update_data(comment=text)
        data = await state.get_data()
        await show_preview(msg, data)
        await state.set_state(NewSale.confirming)

    @dp.callback_query(F.data == "confirm:no", NewSale.confirming)
    async def cb_cancel_confirm(cb: CallbackQuery, state: FSMContext) -> None:
        await state.clear()
        await cb.message.answer("Отменено. /new — чтобы добавить ещё одну.")
        await cb.answer()

    @dp.callback_query(F.data == "confirm:yes", NewSale.confirming)
    async def cb_save(cb: CallbackQuery, state: FSMContext) -> None:
        data = await state.get_data()
        await cb.answer("Сохраняю…")
        try:
            sale = await asyncio.to_thread(_create_sale, data)
        except Exception as exc:  # noqa: BLE001
            logger.exception("sale create failed")
            await cb.message.answer(
                f"❌ Не получилось сохранить: `{exc}`", parse_mode="Markdown"
            )
            return
        await cb.message.answer(
            f"✅ Продажа `#{sale.id}` сохранена!\n\n/new — добавить ещё одну.",
            parse_mode="Markdown",
        )
        await state.clear()

    logger.info("Bot started — polling…")
    await dp.start_polling(bot)


def _create_sale(data: dict):
    """
    Wraps the same `sale_create` service the web API uses, so audit log +
    line allocations come for free. `op_lines` / `partner_lines` from
    FSM state are already in the {operator_id|operator_name, amount}
    shape the service expects.
    """
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

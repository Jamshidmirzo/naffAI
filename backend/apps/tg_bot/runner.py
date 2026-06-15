"""
Step-by-step Telegram bot for adding sales.

Replaces the old free-text parser. Conversation flow:

  /start | /new → model → IMEI → amount → operator → partner
                 → date → (optional) comment → preview → confirm/cancel

State is kept per-chat in `MemoryStorage`. Every screen except the free-text
prompts uses an inline keyboard so the user can tap their way through. On
confirm we call the same `sale_create` service the UI uses — multi-line
operator/partner support is baked in but exposed in single-line form for
the bot, which is what the shop actually needs day-to-day.

Run via `docker compose --profile bot up bot` after setting
`TELEGRAM_BOT_TOKEN` in `.env`.
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
        operator = State()
        partner = State()
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

    def operator_kb(ops: list[tuple[int, str]]) -> InlineKeyboardMarkup:
        rows = []
        for i in range(0, len(ops), 2):
            chunk = ops[i : i + 2]
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

    def partner_kb(partners: list[tuple[int, str]]) -> InlineKeyboardMarkup:
        rows = []
        for i in range(0, len(partners), 2):
            chunk = partners[i : i + 2]
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

    def fmt_money(value) -> str:
        try:
            return f"{int(value):,}".replace(",", " ") + " сум"
        except (TypeError, ValueError):
            return str(value)

    async def show_preview(target: Message, data: dict) -> None:
        text = (
            "📋 *Проверь продажу:*\n\n"
            f"📱 *Модель:* {data['model']}\n"
            f"🔢 *IMEI:* `{data['imei']}`\n"
            f"💰 *Сумма:* {fmt_money(data['amount'])}\n"
            f"👤 *Оператор:* {data['operator_label']}\n"
            f"🤝 *Партнёр:* {data['partner_label']}\n"
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
        await msg.answer(
            "Теперь *IMEI* (6–15 цифр).",
            parse_mode="Markdown",
        )
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
        await state.update_data(amount=str(amt))
        ops = await fetch_operators()
        if not ops:
            await msg.answer("Нет активных операторов. Создай их в дашборде сначала.")
            await state.clear()
            return
        await msg.answer("Кто продал? Выбери из списка или впиши имя.", reply_markup=operator_kb(ops))
        await state.set_state(NewSale.operator)

    @dp.callback_query(F.data.startswith(OP_CALLBACK_PREFIX), NewSale.operator)
    async def cb_operator(cb: CallbackQuery, state: FSMContext) -> None:
        payload = cb.data.removeprefix(OP_CALLBACK_PREFIX)
        if payload == "new":
            await cb.message.answer("Впиши имя оператора.")
        else:
            from apps.operators.models import Operator

            def _g():
                return Operator.objects.filter(pk=int(payload)).values("id", "full_name").first()

            row = await asyncio.to_thread(_g)
            if not row:
                await cb.answer("Не нашёл оператора", show_alert=True)
                return
            await state.update_data(operator_id=row["id"], operator_label=row["full_name"])
            await _ask_partner(cb.message, state)
        await cb.answer()

    @dp.message(NewSale.operator)
    async def step_operator_name(msg: Message, state: FSMContext) -> None:
        name = (msg.text or "").strip()
        if not name:
            await msg.answer("Имя не может быть пустым.")
            return
        await state.update_data(operator_name=name, operator_label=name)
        await _ask_partner(msg, state)

    async def _ask_partner(target_msg: Message, state: FSMContext) -> None:
        partners = await fetch_partners()
        if not partners:
            await target_msg.answer("Нет активных партнёров. Создай их в дашборде сначала.")
            await state.clear()
            return
        await target_msg.answer(
            "Через какого партнёра оплата? (Alif/Birzum/Hamroh/Cash/...)",
            reply_markup=partner_kb(partners),
        )
        await state.set_state(NewSale.partner)

    @dp.callback_query(F.data.startswith(PARTNER_CALLBACK_PREFIX), NewSale.partner)
    async def cb_partner(cb: CallbackQuery, state: FSMContext) -> None:
        payload = cb.data.removeprefix(PARTNER_CALLBACK_PREFIX)
        if payload == "new":
            await cb.message.answer("Впиши название партнёра.")
        else:
            from apps.catalog.models import Channel

            def _g():
                return Channel.objects.filter(pk=int(payload)).values("id", "name").first()

            row = await asyncio.to_thread(_g)
            if not row:
                await cb.answer("Не нашёл партнёра", show_alert=True)
                return
            await state.update_data(partner_id=row["id"], partner_label=row["name"])
            await _ask_date(cb.message, state)
        await cb.answer()

    @dp.message(NewSale.partner)
    async def step_partner_name(msg: Message, state: FSMContext) -> None:
        name = (msg.text or "").strip()
        if not name:
            await msg.answer("Название не может быть пустым.")
            return
        await state.update_data(partner_name=name, partner_label=name)
        await _ask_date(msg, state)

    async def _ask_date(target_msg: Message, state: FSMContext) -> None:
        await target_msg.answer("Какая дата продажи?", reply_markup=date_kb())
        await state.set_state(NewSale.date)

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

    async def _ask_comment(target_msg: Message, state: FSMContext) -> None:
        await target_msg.answer(
            "Комментарий? Напиши текст или `-` чтобы пропустить.",
            parse_mode="Markdown",
        )
        await state.set_state(NewSale.comment)

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
        except Exception as exc:  # noqa: BLE001 — surface anything cleanly
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
    Sync entry — runs inside `asyncio.to_thread` so the Django ORM call
    doesn't block the event loop. Wraps the same `sale_create` service the
    web API uses, so audit log + line allocations come for free.
    """
    from apps.sales.services import sale_create

    tz = timezone.get_current_timezone()
    date_iso = data["date_iso"]
    sold_at = dt.datetime.fromisoformat(date_iso).replace(hour=12, tzinfo=tz)

    op_line = {"amount": str(data["amount"])}
    if data.get("operator_id"):
        op_line["operator_id"] = data["operator_id"]
    else:
        op_line["operator_name"] = data["operator_name"]

    partner_line = {"amount": str(data["amount"])}
    if data.get("partner_id"):
        partner_line["partner_id"] = data["partner_id"]
    else:
        partner_line["partner_name"] = data["partner_name"]

    return sale_create(
        imei=data["imei"],
        phone_model=data["model"],
        operators=[op_line],
        partners=[partner_line],
        comment=data.get("comment", ""),
        sold_at=sold_at,
        allow_duplicate_imei=True,
        duplicate_override_comment="из Telegram-бота",
    )


if __name__ == "__main__":
    asyncio.run(main())

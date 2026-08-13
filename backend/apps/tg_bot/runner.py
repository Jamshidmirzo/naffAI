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

    class LinkOperator(StatesGroup):
        phone = State()

    bot = Bot(token=token)
    dp = Dispatcher(storage=MemoryStorage())

    # v2 middlewares: audit every update + refresh BotChat registry + attach role.
    # Ordering matters: ChatRegistry first (so BotChat exists), then RBAC
    # (reads that chat's role), then Audit (which shouldn't fail the pipeline).
    from apps.tg_bot.middlewares import (
        AuditMiddleware,
        ChatRegistryMiddleware,
        RBACMiddleware,
    )

    dp.update.outer_middleware(ChatRegistryMiddleware())
    dp.update.outer_middleware(AuditMiddleware())
    dp.update.outer_middleware(RBACMiddleware())

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

    def operator_kb(
        ops: list[tuple[int, str]], picked_ids: set[int], lang: str
    ) -> InlineKeyboardMarkup:
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
            [
                InlineKeyboardButton(
                    text=t("btn_type_op", lang), callback_data=f"{OP_CALLBACK_PREFIX}new"
                )
            ]
        )
        return InlineKeyboardMarkup(inline_keyboard=rows)

    def partner_kb(
        partners: list[tuple[int, str]], picked_ids: set[int], lang: str
    ) -> InlineKeyboardMarkup:
        rows = []
        available = [(pid, name) for pid, name in partners if pid not in picked_ids]
        for i in range(0, len(available), 2):
            chunk = available[i : i + 2]
            rows.append(
                [
                    InlineKeyboardButton(text=name, callback_data=f"{PARTNER_CALLBACK_PREFIX}{pid}")
                    for pid, name in chunk
                ]
            )
        rows.append(
            [
                InlineKeyboardButton(
                    text=t("btn_type_partner", lang), callback_data=f"{PARTNER_CALLBACK_PREFIX}new"
                )
            ]
        )
        return InlineKeyboardMarkup(inline_keyboard=rows)

    def split_choice_kb(role: str, total_label: str, lang: str) -> InlineKeyboardMarkup:
        return InlineKeyboardMarkup(
            inline_keyboard=[
                [
                    InlineKeyboardButton(
                        text=t("btn_take_all", lang, label=total_label),
                        callback_data=f"{role}-split:all",
                    )
                ],
                [
                    InlineKeyboardButton(
                        text=t("btn_split", lang), callback_data=f"{role}-split:split"
                    )
                ],
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
                    InlineKeyboardButton(
                        text=t("btn_ru", "ru"), callback_data=f"{LANG_CALLBACK_PREFIX}ru"
                    ),
                    InlineKeyboardButton(
                        text=t("btn_uz", "uz"), callback_data=f"{LANG_CALLBACK_PREFIX}uz"
                    ),
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
        picked_ids = {
            o.get("operator_id") for o in data.get("op_lines", []) if o.get("operator_id")
        }
        await target_msg.answer(
            t("ask_operator", lang), reply_markup=operator_kb(ops, picked_ids, lang)
        )
        await state.set_state(NewSale.operator_pick)

    async def _ask_partner_picker(target_msg: Message, state: FSMContext, lang: str) -> None:
        partners = await fetch_partners()
        if not partners:
            await target_msg.answer(t("no_partners", lang))
            await state.clear()
            return
        data = await state.get_data()
        picked_ids = {
            p.get("partner_id") for p in data.get("partner_lines", []) if p.get("partner_id")
        }
        await target_msg.answer(
            t("ask_partner", lang), reply_markup=partner_kb(partners, picked_ids, lang)
        )
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
    async def cmd_subscribe(msg: Message, **data) -> None:
        from apps.tg_bot.middlewares import require_role
        from apps.tg_bot.models import BotSubscription

        lang = await lang_for(msg)
        if not await require_role(
            data,
            msg,
            needed="manager",
            deny_message="⛔ Эта команда только для менеджеров. Настройте отчёты через веб-панель.",
        ):
            return

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
        """
        /report                — list available preset slugs.
        /report <preset_slug>  — render the preset on-demand and send it here.

        Falls back to the legacy daily-report builder if `/report legacy`
        is passed (keeps historical behaviour for one release).
        """
        parts = (msg.text or "").split(maxsplit=1)
        arg = parts[1].strip().lower() if len(parts) > 1 else ""
        lang = await lang_for(msg)

        if not arg:
            text = await asyncio.to_thread(_ondemand_list_templates, lang)
            await msg.answer(text, parse_mode="HTML")
            return
        if arg == "legacy":
            text = await asyncio.to_thread(build_daily_report, None, lang)
            await msg.answer(text, parse_mode="Markdown")
            return

        result = await asyncio.to_thread(_ondemand_render_by_preset, arg, msg.chat.id)
        if not result:
            text = await asyncio.to_thread(_ondemand_list_templates, lang)
            await msg.answer("Пресет не найден.\n\n" + text, parse_mode="HTML")
            return

        # result = (html, reply_markup_or_None)
        html, kb = result
        await msg.answer(html, parse_mode="HTML", disable_web_page_preview=True, reply_markup=kb)

    @dp.message(Command("sales"))
    async def cmd_sales(msg: Message) -> None:
        """Quick sales summary. `/sales [today|week|month]` (default today)."""
        parts = (msg.text or "").split(maxsplit=1)
        period = parts[1].strip().lower() if len(parts) > 1 else "today"
        if period not in ("today", "yesterday", "week", "month"):
            period = "today"
        result = await asyncio.to_thread(
            _ondemand_render_adhoc,
            ["sales_total", "top_operators", "wow_growth", "average_check"],
            period,
            msg.chat.id,
        )
        html, kb = result
        await msg.answer(html, parse_mode="HTML", disable_web_page_preview=True, reply_markup=kb)

    @dp.message(Command("leads"))
    async def cmd_leads(msg: Message) -> None:
        """Funnel snapshot for this week."""
        result = await asyncio.to_thread(
            _ondemand_render_adhoc,
            ["funnel", "hot_leads", "stale_leads", "callback_backlog"],
            "week",
            msg.chat.id,
        )
        html, kb = result
        await msg.answer(html, parse_mode="HTML", disable_web_page_preview=True, reply_markup=kb)

    @dp.message(Command("find"))
    async def cmd_find(msg: Message) -> None:
        """Lookup client by phone / name across Leads + Sales."""
        parts = (msg.text or "").split(maxsplit=1)
        query = parts[1].strip() if len(parts) > 1 else ""
        if not query:
            await msg.answer(
                "Использование: <code>/find телефон_или_имя</code>",
                parse_mode="HTML",
            )
            return
        text = await asyncio.to_thread(_ondemand_find, query)
        await msg.answer(text, parse_mode="HTML", disable_web_page_preview=True)

    @dp.message(Command("link"))
    async def cmd_link(msg: Message) -> None:
        """Bind the sender's Telegram user id to the profile that generated
        the one-time code via `POST /api/me/telegram/link/`."""
        parts = (msg.text or "").split()
        code = parts[1].strip() if len(parts) >= 2 else ""
        if not code or not code.isdigit() or len(code) != 6:
            await msg.answer(
                "Пришлите команду в формате `/link 123456` — 6-значный код "
                "выдаёт страница «Профиль» в веб-интерфейсе.",
                parse_mode="Markdown",
            )
            return

        def _bind() -> tuple[str, str | None]:
            from django.utils import timezone

            from apps.tg_bot.models import BotSubscription
            from apps.users.models import Profile

            now = timezone.now()
            profile = (
                Profile.objects.filter(tg_link_code=code)
                .filter(tg_link_code_expires_at__gt=now)
                .select_related("user")
                .first()
            )
            if profile is None:
                return ("bad", None)

            # If another profile is already linked to this chat, unlink it first.
            Profile.objects.filter(telegram_user_id=msg.chat.id).exclude(pk=profile.pk).update(
                telegram_user_id=None
            )

            profile.telegram_user_id = msg.chat.id
            profile.tg_link_code = ""
            profile.tg_link_code_expires_at = None
            profile.save(
                update_fields=[
                    "telegram_user_id",
                    "tg_link_code",
                    "tg_link_code_expires_at",
                ]
            )
            # Opt-in the freshly-linked chat to the daily report / long-shift
            # broadcasts. The user can toggle this off later with /unsubscribe.
            sub, _ = BotSubscription.objects.get_or_create(chat_id=msg.chat.id)
            if not sub.is_active:
                sub.is_active = True
                sub.save(update_fields=["is_active", "updated_at"])
            return ("ok", profile.user.username)

        outcome, username = await asyncio.to_thread(_bind)
        if outcome == "ok":
            await msg.answer(
                f"✅ Готово. Ваш Telegram привязан к аккаунту <b>{username}</b>.\n\n"
                "Сюда будут приходить:\n"
                "• 💰 уведомления о новых продажах;\n"
                "• ⏰ напоминания о просроченных колбэках;\n"
                "• 📊 утренний отчёт по посещаемости в 09:00.\n\n"
                "Если утренний отчёт не нужен — отправьте /unsubscribe "
                "(привязка сохранится, продажи и колбэки продолжат приходить).",
                parse_mode="HTML",
            )
        else:
            await msg.answer(
                "❌ Код неверный или уже истёк. Сгенерируйте новый на "
                "странице «Профиль» → «Telegram-уведомления»."
            )

    @dp.message(Command("whoami"))
    async def cmd_whoami(msg: Message) -> None:
        def _lookup():
            from apps.users.models import Profile

            p = Profile.objects.filter(telegram_user_id=msg.chat.id).select_related("user").first()
            return (p.user.username, p.role) if p else (None, None)

        username, role = await asyncio.to_thread(_lookup)
        if username:
            await msg.answer(
                f"👤 Вы вошли как <b>{username}</b> ({role}).\nОтвязать — /unlink",
                parse_mode="HTML",
            )
        else:
            await msg.answer(
                "Ваш Telegram пока не связан ни с одним аккаунтом.\n"
                "Откройте /profile в веб-интерфейсе, нажмите «Telegram-уведомления → "
                "Получить код», затем пришлите сюда `/link 123456`.",
                parse_mode="Markdown",
            )

    @dp.message(Command("unlink"))
    async def cmd_unlink(msg: Message) -> None:
        def _unlink() -> int:
            from apps.users.models import Profile

            return Profile.objects.filter(telegram_user_id=msg.chat.id).update(
                telegram_user_id=None
            )

        n = await asyncio.to_thread(_unlink)
        if n:
            await msg.answer("✓ Telegram отвязан. Уведомления больше не будут приходить.")
        else:
            await msg.answer("Здесь нечего отвязывать — этот Telegram не был привязан.")

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
                t(
                    "ask_op_amount_rem",
                    lang,
                    label=op_lines[-1]["label"],
                    rem=fmt_money(remaining, lang),
                ),
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
            await msg.answer(
                t("amount_too_big", lang, rem=fmt_money(max_for_current, lang)),
                parse_mode="Markdown",
            )
            return
        op_lines[-1]["amount"] = str(amt)
        await state.update_data(op_lines=op_lines)
        new_rem = total - _allocated(op_lines)
        if new_rem == 0:
            await msg.answer(
                t("ops_done", lang, summary=_lines_summary(op_lines, lang)), parse_mode="Markdown"
            )
            await _ask_partner_picker(msg, state, lang)
        else:
            await msg.answer(
                t("remaining_to_whom", lang, rem=fmt_money(new_rem, lang)), parse_mode="Markdown"
            )
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
                t(
                    "ask_partner_amount_rem",
                    lang,
                    label=partner_lines[-1]["label"],
                    rem=fmt_money(remaining, lang),
                ),
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
            t("ask_partner_amount_type", lang, label=partner_lines[-1]["label"]),
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
            await msg.answer(
                t("amount_too_big", lang, rem=fmt_money(max_for_current, lang)),
                parse_mode="Markdown",
            )
            return
        partner_lines[-1]["amount"] = str(amt)
        await state.update_data(partner_lines=partner_lines)
        new_rem = total - _allocated(partner_lines)
        if new_rem == 0:
            await msg.answer(
                t("partners_done", lang, summary=_lines_summary(partner_lines, lang)),
                parse_mode="Markdown",
            )
            await _ask_date(msg, state, lang)
        else:
            await msg.answer(
                t("remaining_via_whom", lang, rem=fmt_money(new_rem, lang)), parse_mode="Markdown"
            )
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
        except Exception as exc:
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

            from apps.tg_bot.selectors import subscriptions_ready_for_dm

            def _subs():
                from django.db import close_old_connections

                close_old_connections()
                today = timezone.localdate()
                return list(
                    subscriptions_ready_for_dm()
                    .exclude(last_daily_report_date=today)
                    .values_list("id", "chat_id", "language")
                )

            def _mark_sent(sub_id: int):
                from django.db import close_old_connections

                from apps.tg_bot.models import BotSubscription

                close_old_connections()
                today = timezone.localdate()
                BotSubscription.objects.filter(id=sub_id).update(last_daily_report_date=today)

            try:
                rows = await asyncio.to_thread(_subs)
            except Exception:
                logger.exception("loading subscriptions failed")
                continue

            def _build_report(lang: str) -> str:
                from django.db import close_old_connections

                close_old_connections()
                return build_daily_report(None, lang)

            # Build report once per language so we don't aggregate N times for N subscribers.
            cache: dict[str, str] = {}
            for sub_id, chat_id, lang in rows:
                if lang not in cache:
                    try:
                        cache[lang] = await asyncio.to_thread(_build_report, lang)
                    except Exception:
                        logger.exception("daily report build failed for lang=%s", lang)
                        cache[lang] = "report-build-failed"
                try:
                    await bot.send_message(chat_id, cache[lang], parse_mode="Markdown")
                    await asyncio.to_thread(_mark_sent, sub_id)
                except Exception:
                    logger.exception("send_message to %s failed", chat_id)

    # Slash-menu — Telegram caches per language, so we register for both.
    common = [
        ("new", "cmd_new"),
        ("report", "cmd_report"),
        ("sales", "cmd_sales"),
        ("leads", "cmd_leads"),
        ("find", "cmd_find"),
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

    # ---------- Operator link (FSM /link_operator) ----------

    @dp.message(Command("link_operator"))
    async def cmd_link_operator(msg: Message, state: FSMContext) -> None:
        await msg.answer("Пришли номер, привязанный к твоему оператору (в формате +998...):")
        await state.set_state(LinkOperator.phone)

    @dp.message(LinkOperator.phone)
    async def step_link_operator_phone(msg: Message, state: FSMContext) -> None:
        raw = (msg.text or "").strip()
        result = await asyncio.to_thread(_link_operator_by_phone, raw, msg.from_user.id)
        await state.clear()
        await msg.answer(result)

    # ---------- Attendance Check-in / Check-out ----------

    @dp.message(Command("checkin"))
    async def cmd_checkin(msg: Message) -> None:
        tg_user_id = msg.from_user.id
        username = msg.from_user.username or "-"
        result = await asyncio.to_thread(_bot_attendance_checkin, tg_user_id, username)
        await msg.answer(result, parse_mode="HTML")

    @dp.message(Command("checkout"))
    async def cmd_checkout(msg: Message) -> None:
        tg_user_id = msg.from_user.id
        username = msg.from_user.username or "-"
        result = await asyncio.to_thread(_bot_attendance_checkout, tg_user_id, username)
        await msg.answer(result, parse_mode="HTML")

    @dp.message(Command("status"))
    async def cmd_status(msg: Message) -> None:
        tg_user_id = msg.from_user.id
        result = await asyncio.to_thread(_bot_attendance_status, tg_user_id)
        await msg.answer(result, parse_mode="HTML")

    @dp.callback_query(F.data == "attendance:checkin")
    async def cb_attendance_checkin(cb: CallbackQuery) -> None:
        tg_user_id = cb.from_user.id
        username = cb.from_user.username or "-"
        result = await asyncio.to_thread(_bot_attendance_checkin, tg_user_id, username)
        await cb.answer()
        await cb.message.answer(result, parse_mode="HTML")

    @dp.callback_query(F.data.startswith("attendance:auto_checkout_confirm:"))
    async def cb_auto_checkout_confirm(cb: CallbackQuery) -> None:
        try:
            _, _, log_id_s = cb.data.split(":", 2)
            log_id = int(log_id_s)
        except (ValueError, IndexError):
            await cb.answer()
            return

        res = await asyncio.to_thread(_bot_auto_checkout_confirm, cb.from_user.id, log_id)
        if res["ok"]:
            await cb.answer(res["msg"])
            try:
                await cb.message.edit_reply_markup(reply_markup=None)
            except Exception:
                pass
            await cb.message.answer(res["text"])
        else:
            await cb.answer(res["msg"], show_alert=res.get("alert", False))

    @dp.callback_query(F.data.startswith("attendance:continue_working:"))
    async def cb_continue_working(cb: CallbackQuery) -> None:
        try:
            _, _, log_id_s = cb.data.split(":", 2)
            log_id = int(log_id_s)
        except (ValueError, IndexError):
            await cb.answer()
            return

        res = await asyncio.to_thread(_bot_continue_working, cb.from_user.id, log_id)
        if res["ok"]:
            await cb.answer(res["msg"])
            try:
                await cb.message.edit_reply_markup(reply_markup=None)
            except Exception:
                pass
            await cb.message.answer(res["text"])
        else:
            await cb.answer(res["msg"], show_alert=res.get("alert", False))

    # ---------- Callback DM buttons ----------

    @dp.callback_query(F.data.startswith("cb-done:"))
    async def cb_done(cb: CallbackQuery) -> None:
        try:
            _, cb_id_s = cb.data.split(":", 1)
            cb_id = int(cb_id_s)
        except (ValueError, IndexError):
            await cb.answer()
            return
        ok = await asyncio.to_thread(_bot_complete_callback, cb_id)
        if ok:
            await cb.answer("Готово!")
            try:
                await cb.message.edit_reply_markup(reply_markup=None)
            except Exception:
                pass
        else:
            await cb.answer("Не удалось")
            kb = InlineKeyboardMarkup(
                inline_keyboard=[
                    [InlineKeyboardButton(text="🔄 Повторить", callback_data=f"cb-done:{cb_id}")]
                ]
            )
            try:
                await cb.message.edit_text(
                    "Не удалось отметить, попробуй ещё раз.",
                    reply_markup=kb,
                )
            except Exception:
                pass

    @dp.callback_query(F.data.startswith("cb-snooze:"))
    async def cb_snooze(cb: CallbackQuery) -> None:
        try:
            _, cb_id_s, minutes_s = cb.data.split(":", 2)
            cb_id = int(cb_id_s)
            minutes = int(minutes_s)
        except (ValueError, IndexError):
            await cb.answer()
            return
        ok = await asyncio.to_thread(_bot_snooze_callback, cb_id, minutes)
        if ok:
            await cb.answer(f"Отложено на +{minutes} мин")
            try:
                await cb.message.edit_reply_markup(reply_markup=None)
            except Exception:
                pass
        else:
            await cb.answer("Не удалось")
            kb = InlineKeyboardMarkup(
                inline_keyboard=[
                    [
                        InlineKeyboardButton(
                            text="🔄 Повторить", callback_data=f"cb-snooze:{cb_id}:{minutes}"
                        )
                    ]
                ]
            )
            try:
                await cb.message.edit_text(
                    "Не удалось отложить, попробуй ещё раз.",
                    reply_markup=kb,
                )
            except Exception:
                pass

    # v2: react to bot being added / removed from a chat so BotChat stays
    # in sync. Aiogram receives `my_chat_member` on chat-membership changes.
    @dp.my_chat_member()
    async def on_my_chat_member(event) -> None:
        from asgiref.sync import sync_to_async

        from apps.tg_bot.middlewares import _upsert_chat
        from apps.tg_bot.models import BotChat

        chat = event.chat
        new_status = event.new_chat_member.status
        try:
            await sync_to_async(_upsert_chat)(chat)
            if new_status in ("left", "kicked"):
                # Deactivate — cron will skip.
                def _deact():
                    BotChat.objects.filter(chat_id=chat.id).update(is_active=False)

                await sync_to_async(_deact)()
            elif new_status in ("member", "administrator") and chat.type in (
                "group",
                "supergroup",
            ):
                # Greet the group once — silent otherwise (we don't reply
                # on every /start there to avoid noise).
                try:
                    await bot.send_message(
                        chat.id,
                        "👋 <b>NaffAI-bot</b> добавлен в чат.\n"
                        "Менеджер увидит эту группу в веб-настройках и настроит рассылку отчётов.",
                        parse_mode="HTML",
                    )
                except Exception:
                    pass
        except Exception:
            logger.exception("my_chat_member handling failed chat_id=%s", chat.id)

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


# ---------------------------------------------------------------------------
# Operator linkage + callback DM handlers (sync helpers used from asyncio.to_thread)
# ---------------------------------------------------------------------------


def _link_operator_by_phone(raw_phone: str, tg_user_id: int) -> str:
    from apps.common.validators import normalize_uz_phone
    from apps.operators.models import Operator
    from apps.users.models import Profile

    normalized, valid = normalize_uz_phone(raw_phone)
    if not valid:
        return "Не смог разобрать номер. Формат: +998XXXXXXXXX"
    op = Operator.objects.filter(phone=normalized).first()
    if not op:
        return (
            f"Оператор с номером {normalized} не найден. "
            "Попроси тимлида добавить твой номер в карточку оператора."
        )
    profile = Profile.objects.filter(operator=op).first()
    if not profile:
        return (
            f"Оператор «{op.full_name}» найден, но у него нет пользователя. "
            "Тимлид должен создать пользователя и привязать его к оператору."
        )
    if profile.telegram_user_id and profile.telegram_user_id != tg_user_id:
        return "К этому оператору уже привязан другой Telegram-аккаунт."
    profile.telegram_user_id = tg_user_id
    profile.save(update_fields=["telegram_user_id"])
    return f"Готово! Ты привязан к оператору «{op.full_name}»."


def _bot_complete_callback(cb_id: int) -> bool:
    from apps.calls.selectors import callback_get
    from apps.calls.services import callback_reminder_complete

    cb = callback_get(cb_id)
    if not cb:
        return False
    callback_reminder_complete(reminder=cb)
    return True


def _bot_snooze_callback(cb_id: int, minutes: int) -> bool:
    from apps.calls.selectors import callback_get
    from apps.calls.services import callback_reminder_snooze

    cb = callback_get(cb_id)
    if not cb:
        return False
    try:
        callback_reminder_snooze(reminder=cb, minutes=minutes)
    except Exception:
        return False
    return True


def _bot_attendance_checkin(tg_user_id: int, username: str) -> str:
    from apps.attendance.selectors import open_log_for_operator
    from apps.attendance.services import (
        ScanRateLimitError,
        TgCheckinDisabledError,
        process_attendance_event,
    )
    from apps.users.models import Profile

    profile = Profile.objects.filter(telegram_user_id=tg_user_id).first()
    if not profile or not profile.operator:
        return "Сначала привяжите аккаунт: /link_operator"

    operator = profile.operator

    open_log = open_log_for_operator(operator)
    if open_log:
        chk_in_local = timezone.localtime(open_log.checked_in_at)
        return f"Смена уже открыта в {chk_in_local.strftime('%H:%M')}. Для завершения используйте /checkout."

    try:
        res = process_attendance_event(
            operator=operator,
            source="tg",
            initiator=f"tg=@{username} id={tg_user_id}",
            issue_token=False,
        )
        chk_time = timezone.localtime(timezone.now()).strftime("%H:%M")
        lateness_min = 0
        if res.get("was_late"):
            from apps.attendance.selectors import attendance_settings_get

            settings_obj = attendance_settings_get()
            shift_start_time = settings_obj.shift_start
            now_local = timezone.localtime(timezone.now())
            if isinstance(shift_start_time, str):
                h, m = map(int, shift_start_time.split(":")[:2])
            else:
                h, m = shift_start_time.hour, shift_start_time.minute
            shift_start_dt = now_local.replace(hour=h, minute=m, second=0, microsecond=0)
            lateness_min = int((now_local - shift_start_dt).total_seconds() / 60)
            if lateness_min < 0:
                lateness_min = 0

        late_msg = f"\nОпоздание: {lateness_min} мин." if res.get("was_late") else ""
        return f"Доброе утро, {operator.full_name}. Отмечен приход в {chk_time}.{late_msg}"

    except ScanRateLimitError:
        return "Подождите 30 секунд."
    except TgCheckinDisabledError:
        return "Отметка через Telegram отключена. Используйте QR на рабочей станции."
    except Exception as exc:
        return f"Ошибка: {exc!s}"


def _bot_attendance_checkout(tg_user_id: int, username: str) -> str:
    from apps.attendance.selectors import open_log_for_operator
    from apps.attendance.services import (
        ScanRateLimitError,
        TgCheckinDisabledError,
        process_attendance_event,
    )
    from apps.users.models import Profile

    profile = Profile.objects.filter(telegram_user_id=tg_user_id).first()
    if not profile or not profile.operator:
        return "Сначала привяжите аккаунт: /link_operator"

    operator = profile.operator
    open_log = open_log_for_operator(operator)
    if not open_log:
        return "Вы сегодня не отмечались. Отметьтесь по QR или командой /checkin."

    try:
        res = process_attendance_event(
            operator=operator,
            source="tg",
            initiator=f"tg=@{username} id={tg_user_id}",
            issue_token=False,
        )
        chk_in_str = timezone.localtime(open_log.checked_in_at).strftime("%H:%M")
        chk_out_str = timezone.localtime(timezone.now()).strftime("%H:%M")
        duration = res.get("duration_min", 0)
        return (
            f"До завтра, {operator.full_name}. Смена: {chk_in_str}–{chk_out_str} ({duration} мин)."
        )
    except ScanRateLimitError:
        return "Подождите 30 секунд."
    except TgCheckinDisabledError:
        return "Отметка через Telegram отключена. Используйте QR на рабочей станции."
    except Exception as exc:
        return f"Ошибка: {exc!s}"


def _bot_attendance_status(tg_user_id: int) -> str:
    from apps.attendance.selectors import open_log_for_operator
    from apps.users.models import Profile

    profile = Profile.objects.filter(telegram_user_id=tg_user_id).first()
    if not profile or not profile.operator:
        return "Сначала привяжите аккаунт: /link_operator"

    operator = profile.operator
    open_log = open_log_for_operator(operator)
    if open_log:
        chk_in_str = timezone.localtime(open_log.checked_in_at).strftime("%H:%M")
        duration_sec = int((timezone.now() - open_log.checked_in_at).total_seconds())
        hours = duration_sec // 3600
        minutes = (duration_sec % 3600) // 60
        return f"Вы на смене с {chk_in_str}, работаете {hours}ч {minutes}мин."
    else:
        return "Вы не на смене."


def _bot_auto_checkout_confirm(tg_user_id: int, log_id: int) -> dict:
    from apps.attendance.models import AttendanceLog
    from apps.attendance.services import process_attendance_event
    from apps.users.models import Profile

    profile = Profile.objects.filter(telegram_user_id=tg_user_id).first()
    if not profile or not profile.operator:
        return {"ok": False, "msg": "Сначала привяжите аккаунт: /link_operator", "alert": True}

    try:
        log = AttendanceLog.objects.get(id=log_id)
    except AttendanceLog.DoesNotExist:
        return {"ok": False, "msg": "Лог смены не найден", "alert": True}

    if log.operator_id != profile.operator_id:
        return {"ok": False, "msg": "Это не твоя смена", "alert": True}

    if log.checked_out_at is not None:
        return {"ok": False, "msg": "Смена уже была закрыта ранее", "alert": True}

    try:
        res = process_attendance_event(
            operator=profile.operator,
            source="tg",
            initiator=f"tg_callback_auto_checkout user_id={tg_user_id}",
            issue_token=False,
        )
        duration = res.get("duration_min", 0)
        return {
            "ok": True,
            "msg": "Смена закрыта",
            "text": f"Хорошего вечера, {profile.operator.full_name}. Смена: {duration} мин.",
        }
    except Exception as exc:
        return {"ok": False, "msg": f"Ошибка: {exc!s}", "alert": True}


def _bot_continue_working(tg_user_id: int, log_id: int) -> dict:
    from apps.attendance.models import AttendanceLog
    from apps.users.models import Profile

    profile = Profile.objects.filter(telegram_user_id=tg_user_id).first()
    if not profile or not profile.operator:
        return {"ok": False, "msg": "Сначала привяжите аккаунт: /link_operator", "alert": True}

    try:
        log = AttendanceLog.objects.get(id=log_id)
    except AttendanceLog.DoesNotExist:
        return {"ok": False, "msg": "Лог смены не найден", "alert": True}

    if log.operator_id != profile.operator_id:
        return {"ok": False, "msg": "Это не твоя смена", "alert": True}

    log.warning_dismissed_at = timezone.now()
    log.save(update_fields=["warning_dismissed_at"])

    return {
        "ok": True,
        "msg": "Продолжайте работу",
        "text": "Ок, продолжай. Повторно не побеспокою.",
    }


# ---------------------------------------------------------------------------
# On-demand /report /sales /leads /find helpers
# ---------------------------------------------------------------------------


def _ondemand_list_templates(language: str) -> str:
    """
    Pretty list of available report presets for `/report` with no args.
    Reads BotReportTemplate — matches the gallery shown in the web UI.
    """
    from apps.tg_bot.models import BotReportTemplate

    rows = list(
        BotReportTemplate.objects.filter(is_active=True)
        .order_by("sort_order", "id")
        .values("slug", "name", "description")
    )
    if not rows:
        return "Пресеты ещё не заданы. Обратитесь к менеджеру."
    lines = ["📋 <b>Доступные пресеты отчётов:</b>", ""]
    for r in rows:
        lines.append(f"• <code>/report {r['slug']}</code> — {r['name']}")
        if r["description"]:
            lines.append(f"    <i>{r['description']}</i>")
    lines.append("")
    lines.append(
        "Или используйте <code>/sales</code>, <code>/leads</code>, <code>/find телефон</code>."
    )
    return "\n".join(lines)


def _resolve_chat(chat_id: int):
    """Look up BotChat by chat_id (Telegram id) — required for RBAC + language."""
    from apps.tg_bot.models import BotChat

    return BotChat.objects.filter(chat_id=chat_id).first()


def _ondemand_render_by_preset(preset_slug: str, chat_id: int):
    """
    Locate a BotReportTemplate by slug and render it against the chat.
    Returns (html, InlineKeyboardMarkup | None) or None if slug unknown.
    """
    from apps.tg_bot.models import BotChat, BotReport, BotReportTemplate
    from apps.tg_bot.renderer import render_report_full
    from apps.tg_bot.scheduler import _build_kb

    template = BotReportTemplate.objects.filter(slug=preset_slug, is_active=True).first()
    if not template:
        return None

    chat = _resolve_chat(chat_id)
    if not chat:
        chat = BotChat(chat_id=chat_id, kind="private", language="ru", title="")

    defaults = template.schedule_defaults or {}
    report = BotReport(
        name=template.name,
        blocks=list(template.blocks or []),
        language=defaults.get("language") or chat.language or "ru",
        period=defaults.get("period") or "today",
        include_header=defaults.get("include_header", True),
        schedule_time=defaults.get("schedule_time") or "09:00:00",
    )
    rendered = render_report_full(report, chat)
    return rendered.html, _build_kb(rendered)


def _ondemand_render_adhoc(blocks: list, period: str, chat_id: int):
    """Build a phantom BotReport with `blocks` + `period` and render for chat."""
    from apps.tg_bot.models import BotChat, BotReport
    from apps.tg_bot.renderer import render_report_full
    from apps.tg_bot.scheduler import _build_kb

    chat = _resolve_chat(chat_id)
    if not chat:
        chat = BotChat(chat_id=chat_id, kind="private", language="ru", title="")

    report = BotReport(
        name={
            "today": "Сегодня",
            "yesterday": "Вчера",
            "week": "Эта неделя",
            "month": "Этот месяц",
        }.get(period, "Отчёт"),
        blocks=blocks,
        language=chat.language or "ru",
        period=period,
        include_header=True,
        schedule_time="09:00:00",
    )
    rendered = render_report_full(report, chat)
    return rendered.html, _build_kb(rendered)


def _ondemand_find(query: str) -> str:
    """
    Search Lead + Sale by phone / name substring. Returns an HTML message
    with up to 5 leads + 5 sales matched.
    """
    import re as _re

    from django.db.models import Q

    from apps.leads.models import Lead
    from apps.sales.models import Sale

    q = (query or "").strip()
    digits = _re.sub(r"\D", "", q)

    lead_qs = Lead.objects.select_related("operator")
    if digits and len(digits) >= 4:
        lead_qs = lead_qs.filter(
            Q(phone__icontains=digits)
            | Q(phone_raw__icontains=digits)
            | Q(phone_alt__icontains=digits)
        )
    else:
        lead_qs = lead_qs.filter(full_name__icontains=q)
    leads = list(lead_qs.order_by("-updated_at")[:5])

    sale_qs = Sale.objects.select_related("operator").filter(is_deleted=False)
    if digits and len(digits) >= 4:
        sale_qs = sale_qs.filter(Q(client_phone__icontains=digits) | Q(imei__icontains=digits))
    else:
        sale_qs = sale_qs.filter(client_name__icontains=q)
    sales = list(sale_qs.order_by("-sold_at")[:5])

    if not leads and not sales:
        return f"🔍 По запросу «{query}» ничего не найдено."

    lines = [f"🔍 <b>Поиск:</b> «{query}»"]
    if leads:
        lines.append(f"\n📋 <b>Лиды ({len(leads)}):</b>")
        for lead in leads:
            phone = lead.phone or lead.phone_raw or "?"
            op = lead.operator.full_name if lead.operator else "—"
            name = (lead.full_name or "(без имени)")[:32]
            lines.append(f"  • <b>{name}</b> · <code>{phone}</code> · {lead.status} · {op}")
    if sales:
        lines.append(f"\n💰 <b>Продажи ({len(sales)}):</b>")
        for sale in sales:
            op = sale.operator.full_name if sale.operator else "—"
            phone = sale.client_phone or "?"
            date = sale.sold_at.strftime("%d.%m")
            amount = f"{int(sale.amount):,}".replace(",", " ")
            lines.append(f"  • #{sale.id} · {sale.phone_model[:24]} · {amount} · {op} · {date}")
    return "\n".join(lines)


if __name__ == "__main__":
    asyncio.run(main())

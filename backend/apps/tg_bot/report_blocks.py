"""
Report blocks — atomic renderers used by the v2 BotReport scheduler.

Each block is a function `render(period, language) -> str | None` that
returns a ready-to-concatenate HTML snippet (Telegram HTML parse mode)
or None to skip. Blocks marked `sensitive=True` are stripped from
messages sent to non-private chats (groups/channels/supergroups) so
per-operator financials never leak to a shared room.

Adding a new block: define a render function, register it in `BLOCKS`.
"""

from __future__ import annotations

import datetime as dt
from dataclasses import dataclass
from decimal import Decimal
from typing import Callable

from django.db.models import Count, Sum
from django.utils import timezone

from apps.sales.models import Sale, SaleOperator, SalePartner


@dataclass(frozen=True)
class BlockSpec:
    slug: str
    label_ru: str
    label_uz: str
    sensitive: bool  # True → skip for group/channel/supergroup
    render: Callable[[dt.datetime, dt.datetime, str], str | None]


def _fmt_amount(value: Decimal | int | float | None) -> str:
    n = int(value or 0)
    if abs(n) >= 1_000_000:
        return f"{n / 1_000_000:.1f} млн".replace(".0 ", " ")
    if abs(n) >= 1_000:
        return f"{n / 1_000:.0f}k"
    return f"{n:,}".replace(",", " ")


def _tr(ru: str, uz: str, language: str) -> str:
    return uz if language == "uz" else ru


# ---------------------------------------------------------------------------
# Blocks
# ---------------------------------------------------------------------------


def render_sales_total(start: dt.datetime, end: dt.datetime, language: str) -> str | None:
    qs = Sale.objects.filter(
        sold_at__gte=start,
        sold_at__lt=end,
        status="confirmed",
        is_deleted=False,
        is_returned=False,
    )
    agg = qs.aggregate(total=Sum("amount"), count=Count("id"))
    total = agg["total"] or Decimal(0)
    count = agg["count"] or 0
    label = _tr("Продажи", "Sotuvlar", language)
    unit = _tr("сум", "so'm", language)
    count_word = _tr(
        f"{count} продаж", f"{count} ta sotuv", language
    )
    return f"💰 <b>{label}:</b> {_fmt_amount(total)} {unit} · {count_word}"


def render_top_operators(start: dt.datetime, end: dt.datetime, language: str) -> str | None:
    qs = (
        SaleOperator.objects.filter(
            sale__sold_at__gte=start,
            sale__sold_at__lt=end,
            sale__status="confirmed",
            sale__is_deleted=False,
            sale__is_returned=False,
        )
        .values("operator__full_name")
        .annotate(total=Sum("amount"))
        .order_by("-total")[:5]
    )
    rows = list(qs)
    if not rows:
        return None
    label = _tr("Топ операторов", "Eng zo'r operatorlar", language)
    lines = [f"🏆 <b>{label}:</b>"]
    medals = ["🥇", "🥈", "🥉", "  ", "  "]
    for i, r in enumerate(rows):
        name = r["operator__full_name"] or "—"
        lines.append(f"  {medals[i]} {name} · <b>{_fmt_amount(r['total'])}</b>")
    return "\n".join(lines)


def render_top_partners(start: dt.datetime, end: dt.datetime, language: str) -> str | None:
    qs = (
        SalePartner.objects.filter(
            sale__sold_at__gte=start,
            sale__sold_at__lt=end,
            sale__status="confirmed",
            sale__is_deleted=False,
            sale__is_returned=False,
        )
        .values("partner__name")
        .annotate(total=Sum("amount"))
        .order_by("-total")[:5]
    )
    rows = list(qs)
    if not rows:
        return None
    label = _tr("Каналы оплаты", "To'lov kanallari", language)
    total_all = sum((r["total"] or 0) for r in rows) or 1
    lines = [f"💳 <b>{label}:</b>"]
    for r in rows:
        share = int((r["total"] or 0) * 100 / total_all)
        lines.append(
            f"  • {r['partner__name'] or '—'} · <b>{_fmt_amount(r['total'])}</b> ({share}%)"
        )
    return "\n".join(lines)


def render_attendance(start: dt.datetime, end: dt.datetime, language: str) -> str | None:
    try:
        from apps.attendance.models import AttendanceLog
    except Exception:
        return None
    today = start.date()
    logs = AttendanceLog.objects.filter(shift_date=today)
    present = logs.filter(checked_in_at__isnull=False).count()
    late = logs.filter(was_late=True).count()
    label = _tr("Смена", "Smena", language)
    parts = [f"✅ {present} " + _tr("на смене", "smenada", language)]
    if late:
        parts.append(f"⏰ {late} " + _tr("опоздал", "kechikkan", language))
    return f"👥 <b>{label}:</b> " + " · ".join(parts)


def render_pending_sales(start: dt.datetime, end: dt.datetime, language: str) -> str | None:
    n = Sale.objects.filter(status="pending", is_deleted=False).count()
    if not n:
        return None
    label = _tr("Ждут подтверждения", "Tasdiq kutmoqda", language)
    return f"📋 <b>{label}:</b> {n}"


def render_callbacks_overdue(start: dt.datetime, end: dt.datetime, language: str) -> str | None:
    try:
        from apps.calls.models import CallbackReminder
    except Exception:
        return None
    n = CallbackReminder.objects.filter(status="overdue").count()
    if not n:
        return None
    label = _tr("Просроченные callback", "O'tkazib yuborilgan qayta qo'ng'iroqlar", language)
    return f"⚠️ <b>{label}:</b> {n}"


def render_leads_stats(start: dt.datetime, end: dt.datetime, language: str) -> str | None:
    try:
        from apps.leads.models import Lead
    except Exception:
        return None
    qs = Lead.objects.filter(created_at__gte=start, created_at__lt=end).values("status").annotate(n=Count("id"))
    by_status = {r["status"]: r["n"] for r in qs}
    if not by_status:
        return None
    label = _tr("Лиды за период", "Davr uchun lidlar", language)
    important = ["new", "assigned", "callback_scheduled", "contacted_telegram", "won", "lost"]
    parts = []
    for st in important:
        n = by_status.get(st, 0)
        if n:
            parts.append(f"{st}:{n}")
    if not parts:
        return None
    return f"📊 <b>{label}:</b> " + " · ".join(parts)


def render_daily_quote(start: dt.datetime, end: dt.datetime, language: str) -> str | None:
    try:
        from apps.greetings.services import get_or_create_daily_quote

        quote = get_or_create_daily_quote(language=language, today=start.date())
    except Exception:
        return None
    if not quote or not quote.text:
        return None
    author = f" — <i>{quote.author}</i>" if quote.author else ""
    return f"💡 <i>«{quote.text}»</i>{author}"


def render_payroll_progress(start: dt.datetime, end: dt.datetime, language: str) -> str | None:
    # Manager-sensitive by default. Show top-3 payroll progress.
    try:
        from apps.operators.models import Operator
    except Exception:
        return None
    month_start = start.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    qs = (
        SaleOperator.objects.filter(
            sale__sold_at__gte=month_start,
            sale__sold_at__lt=end,
            sale__status="confirmed",
            sale__is_deleted=False,
            sale__is_returned=False,
        )
        .values("operator_id", "operator__full_name")
        .annotate(total=Sum("amount"))
        .order_by("-total")[:3]
    )
    rows = list(qs)
    if not rows:
        return None
    label = _tr("Прогресс месяца", "Oyning progresi", language)
    lines = [f"📈 <b>{label}:</b>"]
    for r in rows:
        lines.append(f"  • {r['operator__full_name'] or '—'}: <b>{_fmt_amount(r['total'])}</b>")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------


BLOCKS: dict[str, BlockSpec] = {
    b.slug: b
    for b in [
        BlockSpec("sales_total", "Итого продаж", "Umumiy sotuv", False, render_sales_total),
        BlockSpec("top_operators", "Топ операторов", "Zo'r operatorlar", False, render_top_operators),
        BlockSpec("top_partners", "Каналы оплаты", "To'lov kanallari", False, render_top_partners),
        BlockSpec("attendance", "Посещаемость", "Davomat", False, render_attendance),
        BlockSpec("daily_quote", "Цитата дня", "Kunning iqtiboti", False, render_daily_quote),
        BlockSpec("pending_sales", "Ждут подтверждения", "Tasdiq kutmoqda", True, render_pending_sales),
        BlockSpec("callbacks_overdue", "Просроченные callback", "O'tkazib yuborilgan qo'ng'iroqlar", True, render_callbacks_overdue),
        BlockSpec("leads_stats", "Статистика лидов", "Lidlar statistikasi", True, render_leads_stats),
        BlockSpec("payroll_progress", "Прогресс месяца", "Oyning progresi", True, render_payroll_progress),
    ]
}


NON_PRIVATE_CHAT_KINDS = ("group", "supergroup", "channel")


def blocks_for_chat_kind(chosen_slugs: list[str], chat_kind: str) -> list[BlockSpec]:
    """
    Filter the user-chosen blocks for a specific chat kind. Sensitive
    blocks are dropped when the target is a group/supergroup/channel —
    financial + per-operator + payroll data never leaks to shared rooms.
    """
    is_shared = chat_kind in NON_PRIVATE_CHAT_KINDS
    out: list[BlockSpec] = []
    for slug in chosen_slugs:
        block = BLOCKS.get(slug)
        if not block:
            continue
        if is_shared and block.sensitive:
            continue
        out.append(block)
    return out


def get_period_range(period: str, now: dt.datetime | None = None) -> tuple[dt.datetime, dt.datetime, str, str]:
    """
    Resolve `period` slug to (start, end, label_ru, label_uz).
    All datetimes are in the current timezone (Asia/Tashkent via settings).
    """
    now = now or timezone.localtime()
    today = now.replace(hour=0, minute=0, second=0, microsecond=0)
    end_of_day = today + dt.timedelta(days=1)
    if period == "yesterday":
        start = today - dt.timedelta(days=1)
        return start, today, "Вчера", "Kecha"
    if period == "week":
        start = today - dt.timedelta(days=today.weekday())
        return start, end_of_day, "Эта неделя", "Bu hafta"
    if period == "month":
        start = today.replace(day=1)
        return start, end_of_day, "Этот месяц", "Bu oy"
    return today, end_of_day, "Сегодня", "Bugun"

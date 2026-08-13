"""
Report blocks — atomic renderers used by the v2 BotReport scheduler.

Each block is a function `render(start, end, language) -> str | RenderedBlock | None`.

* Return a string: legacy plain-HTML block, no inline buttons.
* Return a :class:`RenderedBlock` (`html` + `buttons`): the scheduler
  attaches the inline keyboard to that message. Only the LAST block
  with buttons wins per-report (Telegram allows one reply_markup per
  message); other buttons are silently dropped. Sample blocks use it
  to attach a "Open in web" deep-link to the pending / callback /
  hot-leads sections.
* Return None: skip the block.

Blocks marked `sensitive=True` are stripped from messages sent to
non-private chats (groups/channels/supergroups) so per-operator
financial data never leaks to a shared room.

Adding a new block:
  1. define a render function (return str, RenderedBlock, or None);
  2. register it in `BLOCKS` with slug + labels + category + sensitivity.
  3. if you want an inline button, wrap the HTML in RenderedBlock and
     add `InlineButton(...)` entries.

Categories drive the UI grouping in `BotBlockLibrary.tsx`:
  sales | leads | calls | operators | catalog | ops
"""

from __future__ import annotations

import datetime as dt
from collections.abc import Callable
from dataclasses import dataclass, field
from decimal import Decimal

from django.db.models import Count, Sum
from django.utils import timezone

from apps.sales.models import Sale, SaleOperator, SalePartner

# ---------------------------------------------------------------------------
# Public data types
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class InlineButton:
    """A single Telegram inline-keyboard button (URL-only, no callback yet)."""

    text: str
    url: str


@dataclass(frozen=True)
class RenderedBlock:
    """Return this from render() when a block should carry inline buttons."""

    html: str
    buttons: tuple[InlineButton, ...] = field(default_factory=tuple)


BlockOutput = str | RenderedBlock | None


@dataclass(frozen=True)
class BlockSpec:
    slug: str
    label_ru: str
    label_uz: str
    category: str  # sales | leads | calls | operators | catalog | ops
    sensitive: bool  # True → skip for group/channel/supergroup
    render: Callable[[dt.datetime, dt.datetime, str], BlockOutput]


# Block categories — used by the frontend `BotBlockLibrary` to group the
# selector into tabs. Keep the keys stable — they are referenced from
# i18n.ts.
CATEGORIES = ("sales", "leads", "calls", "operators", "catalog", "ops")


# Base URL for inline-button deep-links. Kept in code (not settings) so
# renderers stay pure; if you need to override for staging/demo, use
# BOT_WEB_BASE_URL in settings.py which we read via lazy import inside
# the helper below.
def _web_base() -> str:
    from django.conf import settings

    return getattr(settings, "BOT_WEB_BASE_URL", "https://naff.flek.uz").rstrip("/")


# ---------------------------------------------------------------------------
# Formatting helpers
# ---------------------------------------------------------------------------


def _fmt_amount(value: Decimal | int | float | None) -> str:
    n = int(value or 0)
    if abs(n) >= 1_000_000:
        return f"{n / 1_000_000:.1f} млн".replace(".0 ", " ")
    if abs(n) >= 1_000:
        return f"{n / 1_000:.0f}k"
    return f"{n:,}".replace(",", " ")


def _fmt_amount_full(value: Decimal | int | float | None) -> str:
    """Full number with thousand separators — for reports where '5.2 млн' hides detail."""
    n = int(value or 0)
    return f"{n:,}".replace(",", " ")


def _tr(ru: str, uz: str, language: str) -> str:
    return uz if language == "uz" else ru


def _pct(part: Decimal | int | float | None, total: Decimal | int | float | None) -> int:
    """Rounded percentage, safe on zero."""
    if not total:
        return 0
    return round(float(part or 0) * 100 / float(total))


def _confirmed_sales_qs(start: dt.datetime, end: dt.datetime):
    return Sale.objects.filter(
        sold_at__gte=start,
        sold_at__lt=end,
        status="confirmed",
        is_deleted=False,
        is_returned=False,
    )


def _prev_period(start: dt.datetime, end: dt.datetime) -> tuple[dt.datetime, dt.datetime]:
    """Previous window of equal length, immediately preceding [start, end)."""
    span = end - start
    prev_start = start - span
    return prev_start, start


# ---------------------------------------------------------------------------
# Existing blocks (kept, category tagged)
# ---------------------------------------------------------------------------


def render_sales_total(start: dt.datetime, end: dt.datetime, language: str) -> BlockOutput:
    qs = _confirmed_sales_qs(start, end)
    agg = qs.aggregate(total=Sum("amount"), count=Count("id"))
    total = agg["total"] or Decimal(0)
    count = agg["count"] or 0
    label = _tr("Продажи", "Sotuvlar", language)
    unit = _tr("сум", "so'm", language)
    count_word = _tr(f"{count} продаж", f"{count} ta sotuv", language)
    return f"💰 <b>{label}:</b> {_fmt_amount(total)} {unit} · {count_word}"


def render_top_operators(start: dt.datetime, end: dt.datetime, language: str) -> BlockOutput:
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


def render_top_partners(start: dt.datetime, end: dt.datetime, language: str) -> BlockOutput:
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


def render_attendance(start: dt.datetime, end: dt.datetime, language: str) -> BlockOutput:
    try:
        from apps.attendance.models import AttendanceLog
    except Exception:
        return None
    day_start = start.replace(hour=0, minute=0, second=0, microsecond=0)
    day_end = day_start + dt.timedelta(days=1)
    logs = AttendanceLog.objects.filter(checked_in_at__gte=day_start, checked_in_at__lt=day_end)
    present = logs.count()
    late = logs.filter(was_late=True).count()
    if not present:
        return None
    label = _tr("Смена", "Smena", language)
    parts = [f"✅ {present} " + _tr("на смене", "smenada", language)]
    if late:
        parts.append(f"⏰ {late} " + _tr("опоздал", "kechikkan", language))
    return f"👥 <b>{label}:</b> " + " · ".join(parts)


def render_pending_sales(start: dt.datetime, end: dt.datetime, language: str) -> BlockOutput:
    n = Sale.objects.filter(status="pending", is_deleted=False).count()
    if not n:
        return None
    label = _tr("Ждут подтверждения", "Tasdiq kutmoqda", language)
    btn_label = _tr("Открыть pending", "Pending'ni ochish", language)
    html = f"📋 <b>{label}:</b> {n}"
    return RenderedBlock(
        html=html,
        buttons=(InlineButton(text=btn_label, url=f"{_web_base()}/sales/pending"),),
    )


def render_callbacks_overdue(start: dt.datetime, end: dt.datetime, language: str) -> BlockOutput:
    try:
        from apps.calls.models import CallbackReminder
    except Exception:
        return None
    n = CallbackReminder.objects.filter(status="overdue").count()
    if not n:
        return None
    label = _tr("Просроченные callback", "O'tkazib yuborilgan qayta qo'ng'iroqlar", language)
    btn_label = _tr("Позвонить", "Qo'ng'iroq qilish", language)
    html = f"⚠️ <b>{label}:</b> {n}"
    return RenderedBlock(
        html=html,
        buttons=(InlineButton(text=btn_label, url=f"{_web_base()}/leads?filter=callback_overdue"),),
    )


def render_leads_stats(start: dt.datetime, end: dt.datetime, language: str) -> BlockOutput:
    try:
        from apps.leads.models import Lead
    except Exception:
        return None
    qs = (
        Lead.objects.filter(created_at__gte=start, created_at__lt=end)
        .values("status")
        .annotate(n=Count("id"))
    )
    by_status = {r["status"]: r["n"] for r in qs}
    if not by_status:
        return None
    label = _tr("Лиды за период", "Davr uchun lidlar", language)
    important = [
        "new",
        "assigned",
        "callback_scheduled",
        "contacted_telegram",
        "won",
        "lost",
    ]
    parts = []
    for st in important:
        n = by_status.get(st, 0)
        if n:
            parts.append(f"{st}:{n}")
    if not parts:
        return None
    return f"📊 <b>{label}:</b> " + " · ".join(parts)


def render_daily_quote(start: dt.datetime, end: dt.datetime, language: str) -> BlockOutput:
    try:
        from apps.greetings.services import get_or_create_daily_quote

        quote = get_or_create_daily_quote(language=language, today=start.date())
    except Exception:
        return None
    if not quote or not quote.text:
        return None
    author = f" — <i>{quote.author}</i>" if quote.author else ""
    return f"💡 <i>«{quote.text}»</i>{author}"


def render_payroll_progress(start: dt.datetime, end: dt.datetime, language: str) -> BlockOutput:
    # Manager-sensitive by default. Show top-3 payroll progress for the month.
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
# Wave 2 — Sales
# ---------------------------------------------------------------------------


def render_average_check(start: dt.datetime, end: dt.datetime, language: str) -> BlockOutput:
    """Средний чек за период + delta к предыдущему такому же периоду."""
    now = _confirmed_sales_qs(start, end).aggregate(total=Sum("amount"), n=Count("id"))
    cur_total = now["total"] or Decimal(0)
    cur_n = now["n"] or 0
    if not cur_n:
        return None
    cur_avg = cur_total / cur_n

    prev_start, prev_end = _prev_period(start, end)
    prev = _confirmed_sales_qs(prev_start, prev_end).aggregate(total=Sum("amount"), n=Count("id"))
    prev_avg = (prev["total"] or 0) / prev["n"] if prev["n"] else 0

    label = _tr("Средний чек", "O'rtacha chek", language)
    body = f"🧾 <b>{label}:</b> {_fmt_amount(cur_avg)}"
    if prev_avg:
        pct = _pct(cur_avg - prev_avg, prev_avg)
        arrow = "▲" if pct > 0 else ("▼" if pct < 0 else "→")
        body += f" ({arrow} {abs(pct)}%)"
    return body


def render_wow_growth(start: dt.datetime, end: dt.datetime, language: str) -> BlockOutput:
    """This period vs. previous same-length window — total revenue delta."""
    cur = _confirmed_sales_qs(start, end).aggregate(t=Sum("amount"))["t"] or Decimal(0)
    prev_start, prev_end = _prev_period(start, end)
    prev = _confirmed_sales_qs(prev_start, prev_end).aggregate(t=Sum("amount"))["t"] or Decimal(0)
    if not prev and not cur:
        return None
    label = _tr("Динамика", "Dinamika", language)
    if not prev:
        no_base = _tr("нет базы", "baza yo'q", language)
        return f"📈 <b>{label}:</b> +{_fmt_amount(cur)} ({no_base})"
    delta = cur - prev
    pct = _pct(delta, prev)
    arrow = "▲" if delta > 0 else ("▼" if delta < 0 else "→")
    return f"📈 <b>{label}:</b> {_fmt_amount(cur)} vs {_fmt_amount(prev)} · {arrow} {abs(pct)}%"


def render_hot_items(start: dt.datetime, end: dt.datetime, language: str) -> BlockOutput:
    """Top-5 phone_model'ов по объёму продаж за период."""
    qs = (
        _confirmed_sales_qs(start, end)
        .values("phone_model")
        .annotate(total=Sum("amount"), n=Count("id"))
        .order_by("-total")[:5]
    )
    rows = list(qs)
    if not rows:
        return None
    label = _tr("Хиты продаж", "Sotuv hitlari", language)
    lines = [f"🔥 <b>{label}:</b>"]
    for r in rows:
        name = (r["phone_model"] or "—")[:32]
        lines.append(f"  • {name} · <b>{_fmt_amount(r['total'])}</b> ({r['n']})")
    return "\n".join(lines)


def render_out_of_stock(start: dt.datetime, end: dt.datetime, language: str) -> BlockOutput:
    """Модели каталога со stock_status=out."""
    try:
        from apps.catalog.models import PhoneModel, PhoneStockStatus
    except Exception:
        return None
    qs = PhoneModel.objects.filter(stock_status=PhoneStockStatus.OUT, is_active=True).values_list(
        "brand", "model_name"
    )[:10]
    rows = list(qs)
    if not rows:
        return None
    label = _tr("Нет в наличии", "Mavjud emas", language)
    total = PhoneModel.objects.filter(stock_status=PhoneStockStatus.OUT, is_active=True).count()
    body_lines = [f"📵 <b>{label}:</b> {total}"]
    for brand, model in rows[:5]:
        body_lines.append(f"  • {brand} {model}")
    if total > 5:
        body_lines.append(f"  <i>…{_tr('и ещё', 'yana', language)} {total - 5}</i>")
    return "\n".join(body_lines)


def render_returns_summary(start: dt.datetime, end: dt.datetime, language: str) -> BlockOutput:
    """Возвраты за период: количество + сумма + топ-3 причины."""
    qs = Sale.objects.filter(
        returned_at__gte=start,
        returned_at__lt=end,
        is_returned=True,
        is_deleted=False,
    )
    agg = qs.aggregate(total=Sum("amount"), n=Count("id"))
    n = agg["n"] or 0
    if not n:
        return None
    total = agg["total"] or Decimal(0)
    label = _tr("Возвраты", "Qaytarishlar", language)
    lines = [f"↩️ <b>{label}:</b> {n} · {_fmt_amount(total)}"]
    reasons = (
        qs.exclude(return_reason="")
        .values("return_reason")
        .annotate(k=Count("id"))
        .order_by("-k")[:3]
    )
    for r in reasons:
        preview = (r["return_reason"] or "")[:40]
        lines.append(f"  • {preview} · {r['k']}")
    return "\n".join(lines)


def render_discount_leakage(start: dt.datetime, end: dt.datetime, language: str) -> BlockOutput:
    """Скидки: total + % от gross + топ-3 операторов по объёму скидок."""
    agg = _confirmed_sales_qs(start, end).aggregate(gross=Sum("amount"), disc=Sum("discount"))
    disc = agg["disc"] or Decimal(0)
    gross = agg["gross"] or Decimal(0)
    if not disc:
        return None
    label = _tr("Скидки", "Chegirmalar", language)
    pct = _pct(disc, gross)
    lines = [f"💸 <b>{label}:</b> {_fmt_amount(disc)} · {pct}% от оборота"]

    # Top-3 операторов по discount — берём Sale.discount, атрибутируем
    # операторам через SaleOperator (пропорционально их share).
    top = (
        _confirmed_sales_qs(start, end)
        .filter(discount__gt=0)
        .values("operator__full_name")
        .annotate(disc_total=Sum("discount"))
        .order_by("-disc_total")[:3]
    )
    for r in top:
        name = r["operator__full_name"] or "—"
        lines.append(f"  • {name} · <b>{_fmt_amount(r['disc_total'])}</b>")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Wave 2 — Leads
# ---------------------------------------------------------------------------


def render_funnel(start: dt.datetime, end: dt.datetime, language: str) -> BlockOutput:
    """new → assigned → contacted → won/lost за период."""
    try:
        from apps.leads.models import Lead
    except Exception:
        return None
    qs = (
        Lead.objects.filter(created_at__gte=start, created_at__lt=end)
        .values("status")
        .annotate(n=Count("id"))
    )
    by = {r["status"]: r["n"] for r in qs}
    total = sum(by.values())
    if not total:
        return None
    label = _tr("Воронка лидов", "Lidlar voronkasi", language)
    won = by.get("won", 0)
    lost = by.get("lost", 0)
    new = by.get("new", 0) + by.get("assigned", 0)
    contacted = sum(
        by.get(s, 0)
        for s in (
            "contacted_telegram",
            "callback_scheduled",
            "no_answer",
            "no_answer_2",
            "phone_on",
            "in_progress",
        )
    )
    conv = _pct(won, total)
    lines = [f"📊 <b>{label}:</b> {total} " + _tr("всего", "jami", language)]
    lines.append(f"  • {_tr('Новые', 'Yangi', language)}: {new}")
    lines.append(f"  • {_tr('В работе', 'Ish jarayonida', language)}: {contacted}")
    lost_lbl = _tr("Потерян", "Yo'qotildi", language)
    won_lbl = _tr("Продажа", "Sotuv", language)
    lines.append(f"  • {won_lbl}: {won} ({conv}%) · {lost_lbl}: {lost}")
    return "\n".join(lines)


def render_stale_leads(start: dt.datetime, end: dt.datetime, language: str) -> BlockOutput:
    """Лиды >3 дней без активности, в non-terminal статусах."""
    try:
        from apps.leads.models import Lead
        from apps.leads.selectors import terminal_lead_status_codes
    except Exception:
        return None
    cutoff = timezone.now() - dt.timedelta(days=3)
    terminal = terminal_lead_status_codes()
    n = (
        Lead.objects.filter(updated_at__lt=cutoff)
        .exclude(status__in=terminal)
        .exclude(status__in=("new", "assigned"))
        .filter(operator__isnull=False)
        .count()
    )
    if not n:
        return None
    label = _tr("Зависли >3 дней", "3 kundan ko'p turibdi", language)
    return f"⌛ <b>{label}:</b> {n}"


def render_hot_leads(start: dt.datetime, end: dt.datetime, language: str) -> BlockOutput:
    """Лиды со status_tone=hot (из LeadStatusLabel)."""
    try:
        from apps.leads.models import Lead, LeadStatusLabel
    except Exception:
        return None
    hot_codes = list(
        LeadStatusLabel.objects.filter(is_active=True, tone="hot").values_list("code", flat=True)
    )
    if not hot_codes:
        return None
    n = Lead.objects.filter(status__in=hot_codes).count()
    if not n:
        return None
    label = _tr("Горячие лиды", "Qaynoq lidlar", language)
    btn_label = _tr("Открыть лиды", "Lidlarni ochish", language)
    return RenderedBlock(
        html=f"🌶 <b>{label}:</b> {n}",
        buttons=(InlineButton(text=btn_label, url=f"{_web_base()}/leads?tone=hot"),),
    )


# ---------------------------------------------------------------------------
# Wave 2 — Calls
# ---------------------------------------------------------------------------


def render_call_volume(start: dt.datetime, end: dt.datetime, language: str) -> BlockOutput:
    """Активность звонков: attempts by outcome за период."""
    try:
        from apps.calls.models import CallAttempt
    except Exception:
        return None
    qs = (
        CallAttempt.objects.filter(created_at__gte=start, created_at__lt=end)
        .values("outcome")
        .annotate(n=Count("id"))
    )
    by = {r["outcome"]: r["n"] for r in qs}
    total = sum(by.values())
    if not total:
        return None
    label = _tr("Активность звонков", "Qo'ng'iroqlar", language)
    lines = [f"📞 <b>{label}:</b> {total}"]
    order = [
        ("talked_interested", _tr("разговор", "gaplashildi", language)),
        ("talked_callback", _tr("перезвонить", "qayta qo'ng'iroq", language)),
        ("no_answer", _tr("не ответил", "javob yo'q", language)),
        ("rejected", _tr("отказ", "rad etildi", language)),
    ]
    parts = []
    for code, lbl in order:
        v = by.get(code, 0)
        if v:
            parts.append(f"{lbl}:{v}")
    if parts:
        lines.append("  " + " · ".join(parts))
    return "\n".join(lines)


def render_callback_backlog(start: dt.datetime, end: dt.datetime, language: str) -> BlockOutput:
    """Общий backlog callback'ов: pending/overdue + топ-3 просроченных."""
    try:
        from apps.calls.models import CallbackReminder
    except Exception:
        return None
    counts = (
        CallbackReminder.objects.values("status")
        .annotate(n=Count("id"))
        .filter(status__in=("pending", "overdue", "snoozed"))
    )
    by = {r["status"]: r["n"] for r in counts}
    pending = by.get("pending", 0)
    overdue = by.get("overdue", 0)
    snoozed = by.get("snoozed", 0)
    if not (pending + overdue + snoozed):
        return None
    label = _tr("Callback backlog", "Callback backlogi", language)
    parts = []
    if overdue:
        parts.append(f"⚠️ {overdue} " + _tr("просрочено", "o'tkazib yuborildi", language))
    if pending:
        parts.append(f"⏳ {pending} " + _tr("ожидают", "kutmoqda", language))
    if snoozed:
        parts.append(f"⏸ {snoozed} " + _tr("отложено", "keyinga", language))
    return f"🔔 <b>{label}:</b> " + " · ".join(parts)


# ---------------------------------------------------------------------------
# Wave 2 — Operators
# ---------------------------------------------------------------------------


def render_operator_ranking_multi(
    start: dt.datetime, end: dt.datetime, language: str
) -> BlockOutput:
    """Топ-5 операторов по (revenue, calls, conversion, avg_check)."""
    ops = (
        SaleOperator.objects.filter(
            sale__sold_at__gte=start,
            sale__sold_at__lt=end,
            sale__status="confirmed",
            sale__is_deleted=False,
            sale__is_returned=False,
        )
        .values("operator_id", "operator__full_name")
        .annotate(revenue=Sum("amount"), sales=Count("sale", distinct=True))
        .order_by("-revenue")[:5]
    )
    rows = list(ops)
    if not rows:
        return None

    # Optional call count join — best-effort, doesn't fail if calls app missing.
    call_counts: dict[int, int] = {}
    try:
        from apps.calls.models import CallAttempt

        qs = (
            CallAttempt.objects.filter(
                created_at__gte=start,
                created_at__lt=end,
                operator_id__in=[r["operator_id"] for r in rows],
            )
            .values("operator_id")
            .annotate(n=Count("id"))
        )
        call_counts = {r["operator_id"]: r["n"] for r in qs}
    except Exception:
        pass

    label = _tr("Мульти-рейтинг", "Ko'p ko'rinishli reyting", language)
    lines = [f"🏅 <b>{label}:</b>"]
    for r in rows:
        avg = (r["revenue"] or 0) / (r["sales"] or 1)
        calls = call_counts.get(r["operator_id"], 0)
        lines.append(
            f"  • {r['operator__full_name'] or '—'}: "
            f"{_fmt_amount(r['revenue'])} · "
            f"{r['sales']} " + _tr("продаж", "sotuv", language) + f" · "
            f"⌀ {_fmt_amount(avg)}" + (f" · 📞 {calls}" if calls else "")
        )
    return "\n".join(lines)


def render_shift_status(start: dt.datetime, end: dt.datetime, language: str) -> BlockOutput:
    """Кол-во операторов на смене / офлайн / опоздали сейчас."""
    try:
        from apps.attendance.models import AttendanceLog
        from apps.operators.models import Operator, OperatorStatus
    except Exception:
        return None
    now_local = timezone.localtime()
    day_start = now_local.replace(hour=0, minute=0, second=0, microsecond=0)
    day_end = day_start + dt.timedelta(days=1)
    today_logs = AttendanceLog.objects.filter(
        checked_in_at__gte=day_start, checked_in_at__lt=day_end
    )
    on_shift = today_logs.filter(checked_out_at__isnull=True).count()
    late = today_logs.filter(was_late=True).count()
    total_active = Operator.objects.filter(status=OperatorStatus.ACTIVE).count()
    offline = max(0, total_active - on_shift)
    if total_active == 0:
        return None
    label = _tr("Смена сейчас", "Hozirgi smena", language)
    parts = [f"✅ {on_shift} " + _tr("на смене", "smenada", language)]
    if offline:
        parts.append(f"💤 {offline} " + _tr("офлайн", "oflayn", language))
    if late:
        parts.append(f"⏰ {late} " + _tr("опоздали", "kechikkan", language))
    return f"👥 <b>{label}:</b> " + " · ".join(parts)


# ---------------------------------------------------------------------------
# Wave 2 — Ops (all-in-one digest)
# ---------------------------------------------------------------------------


def render_morning_digest(start: dt.datetime, end: dt.datetime, language: str) -> BlockOutput:
    """
    All-in-one morning summary: shift status + pending sales + overdue
    callbacks + top-3 operators from yesterday. Manager-sensitive.
    """
    lines: list[str] = []
    label = _tr("Утренний свод", "Ertalabki hisobot", language)
    lines.append(f"🌅 <b>{label}:</b>")

    # Shift status.
    try:
        from apps.attendance.models import AttendanceLog
        from apps.operators.models import Operator, OperatorStatus

        now_local = timezone.localtime()
        day_start = now_local.replace(hour=0, minute=0, second=0, microsecond=0)
        day_end = day_start + dt.timedelta(days=1)
        today_logs = AttendanceLog.objects.filter(
            checked_in_at__gte=day_start, checked_in_at__lt=day_end
        )
        on_shift = today_logs.filter(checked_out_at__isnull=True).count()
        total_active = Operator.objects.filter(status=OperatorStatus.ACTIVE).count()
        offline = max(0, total_active - on_shift)
        if total_active:
            lines.append(
                f"  • {_tr('Смена', 'Smena', language)}: "
                f"{on_shift} / {total_active}"
                + (f" ({offline} " + _tr("офлайн", "oflayn", language) + ")" if offline else "")
            )
    except Exception:
        pass

    # Pending sales.
    pending_n = Sale.objects.filter(status="pending", is_deleted=False).count()
    if pending_n:
        lines.append(f"  • {_tr('Ждут подтверждения', 'Tasdiq kutmoqda', language)}: {pending_n}")

    # Overdue callbacks.
    try:
        from apps.calls.models import CallbackReminder

        cb_n = CallbackReminder.objects.filter(status="overdue").count()
        if cb_n:
            cb_lbl = _tr("Просроченные callback", "O'tkazib yuborilgan callback", language)
            lines.append(f"  • {cb_lbl}: {cb_n}")
    except Exception:
        pass

    # Yesterday top-3.
    y_start = start - dt.timedelta(days=1)
    y_end = start
    top_qs = (
        SaleOperator.objects.filter(
            sale__sold_at__gte=y_start,
            sale__sold_at__lt=y_end,
            sale__status="confirmed",
            sale__is_deleted=False,
            sale__is_returned=False,
        )
        .values("operator__full_name")
        .annotate(total=Sum("amount"))
        .order_by("-total")[:3]
    )
    top = list(top_qs)
    if top:
        lines.append(f"  • {_tr('Топ вчера', 'Kechagi top', language)}:")
        medals = ["🥇", "🥈", "🥉"]
        for i, r in enumerate(top):
            lines.append(
                f"     {medals[i]} {r['operator__full_name'] or '—'} · <b>{_fmt_amount(r['total'])}</b>"
            )

    if len(lines) == 1:  # only the header — nothing to report
        return None
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------


BLOCKS: dict[str, BlockSpec] = {
    b.slug: b
    for b in [
        # Sales
        BlockSpec(
            "sales_total", "Итого продаж", "Umumiy sotuv", "sales", False, render_sales_total
        ),
        BlockSpec(
            "top_operators",
            "Топ операторов",
            "Zo'r operatorlar",
            "operators",
            False,
            render_top_operators,
        ),
        BlockSpec(
            "top_partners", "Каналы оплаты", "To'lov kanallari", "sales", False, render_top_partners
        ),
        BlockSpec(
            "average_check", "Средний чек", "O'rtacha chek", "sales", False, render_average_check
        ),
        BlockSpec(
            "wow_growth", "Динамика (WoW)", "Dinamika (WoW)", "sales", False, render_wow_growth
        ),
        BlockSpec("hot_items", "Хиты продаж", "Sotuv hitlari", "sales", False, render_hot_items),
        BlockSpec(
            "returns_summary", "Возвраты", "Qaytarishlar", "sales", True, render_returns_summary
        ),
        BlockSpec(
            "discount_leakage", "Скидки", "Chegirmalar", "sales", True, render_discount_leakage
        ),
        # Leads
        BlockSpec(
            "leads_stats",
            "Статистика лидов",
            "Lidlar statistikasi",
            "leads",
            True,
            render_leads_stats,
        ),
        BlockSpec("funnel", "Воронка лидов", "Lidlar voronkasi", "leads", True, render_funnel),
        BlockSpec(
            "stale_leads", "Зависшие лиды", "Turgan lidlar", "leads", True, render_stale_leads
        ),
        BlockSpec("hot_leads", "Горячие лиды", "Qaynoq lidlar", "leads", True, render_hot_leads),
        # Calls
        BlockSpec(
            "call_volume", "Активность звонков", "Qo'ng'iroqlar", "calls", False, render_call_volume
        ),
        BlockSpec(
            "callbacks_overdue",
            "Просроченные callback",
            "O'tkazib yuborilgan callback",
            "calls",
            True,
            render_callbacks_overdue,
        ),
        BlockSpec(
            "callback_backlog",
            "Callback backlog",
            "Callback backlogi",
            "calls",
            True,
            render_callback_backlog,
        ),
        # Operators
        BlockSpec("attendance", "Посещаемость", "Davomat", "operators", False, render_attendance),
        BlockSpec(
            "operator_ranking_multi",
            "Мульти-рейтинг",
            "Ko'p ko'rinishli reyting",
            "operators",
            False,
            render_operator_ranking_multi,
        ),
        BlockSpec(
            "shift_status", "Смена сейчас", "Hozirgi smena", "operators", False, render_shift_status
        ),
        BlockSpec(
            "payroll_progress",
            "Прогресс месяца",
            "Oyning progresi",
            "operators",
            True,
            render_payroll_progress,
        ),
        # Catalog
        BlockSpec(
            "out_of_stock", "Нет в наличии", "Mavjud emas", "catalog", False, render_out_of_stock
        ),
        # Ops
        BlockSpec(
            "pending_sales",
            "Ждут подтверждения",
            "Tasdiq kutmoqda",
            "ops",
            True,
            render_pending_sales,
        ),
        BlockSpec(
            "daily_quote", "Цитата дня", "Kunning iqtiboti", "ops", False, render_daily_quote
        ),
        BlockSpec(
            "morning_digest",
            "Утренний свод",
            "Ertalabki hisobot",
            "ops",
            True,
            render_morning_digest,
        ),
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


def get_period_range(
    period: str, now: dt.datetime | None = None
) -> tuple[dt.datetime, dt.datetime, str, str]:
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

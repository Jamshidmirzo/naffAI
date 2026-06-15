"""
Daily-report formatter used by the Telegram bot.

Wraps a few aggregations over `Sale` + `SaleOperator` + `SalePartner`
into a single Markdown blob. Pure-Django, no aiogram — so the same
function can be triggered manually by `python manage.py shell` if
debugging on the VPS.
"""

from __future__ import annotations

import datetime as dt
from decimal import Decimal

from django.db.models import Count, Sum
from django.utils import timezone

from apps.sales.models import Sale, SaleOperator, SalePartner


def _fmt_money(value) -> str:
    try:
        return f"{int(Decimal(str(value or 0))):,}".replace(",", " ") + " сум"
    except Exception:  # noqa: BLE001
        return f"{value} сум"


def _aggregate_window(start: dt.datetime, end: dt.datetime) -> dict:
    base = Sale.objects.filter(
        sold_at__gte=start,
        sold_at__lt=end,
        is_deleted=False,
        is_returned=False,
        status="confirmed",
    )
    head = base.aggregate(total=Sum("amount"), count=Count("id"))
    return {
        "total": head["total"] or Decimal(0),
        "count": head["count"] or 0,
        "ids": list(base.values_list("id", flat=True)),
    }


def build_daily_report(for_date: dt.date | None = None) -> str:
    """Return a Markdown-formatted summary for the given local date (default: today)."""
    tz = timezone.get_current_timezone()
    today = for_date or timezone.localdate()
    yesterday = today - dt.timedelta(days=1)

    today_start = dt.datetime.combine(today, dt.time(0, 0), tzinfo=tz)
    today_end = today_start + dt.timedelta(days=1)
    y_start = today_start - dt.timedelta(days=1)
    y_end = today_start

    today_a = _aggregate_window(today_start, today_end)
    yest_a = _aggregate_window(y_start, y_end)

    # Per-operator breakdown for today (via SaleOperator lines so multi-op
    # sales count correctly).
    op_rows = (
        SaleOperator.objects.filter(sale_id__in=today_a["ids"])
        .values("operator__full_name")
        .annotate(total=Sum("amount"), count=Count("sale", distinct=True))
        .order_by("-total")[:8]
    )
    partner_rows = (
        SalePartner.objects.filter(sale_id__in=today_a["ids"])
        .values("partner__name")
        .annotate(total=Sum("amount"), count=Count("sale", distinct=True))
        .order_by("-total")[:8]
    )

    diff = today_a["total"] - yest_a["total"]
    diff_emoji = "📈" if diff > 0 else ("📉" if diff < 0 else "➖")
    diff_label = f"{_fmt_money(abs(diff))} {diff_emoji} к вчера"

    lines: list[str] = []
    lines.append(f"📊 *Отчёт за {today.strftime('%d.%m.%Y')}*")
    lines.append("")
    lines.append(f"💰 Оборот: *{_fmt_money(today_a['total'])}*  ·  {today_a['count']} продаж")
    lines.append(f"📅 Вчера:  {_fmt_money(yest_a['total'])} · {yest_a['count']} продаж")
    lines.append(f"        {diff_label}")
    lines.append("")

    if op_rows:
        lines.append("👤 *Операторы:*")
        for r in op_rows:
            lines.append(
                f"  • {r['operator__full_name']}: {_fmt_money(r['total'])} ({r['count']})"
            )
    else:
        lines.append("👤 *Операторы:* — нет продаж")
    lines.append("")

    if partner_rows:
        lines.append("🤝 *Партнёры:*")
        for r in partner_rows:
            lines.append(
                f"  • {r['partner__name']}: {_fmt_money(r['total'])} ({r['count']})"
            )
    else:
        lines.append("🤝 *Партнёры:* —")

    return "\n".join(lines)

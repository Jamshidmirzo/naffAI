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
from apps.tg_bot.i18n import t


def _fmt_money(value, lang: str) -> str:
    cur = t("rep_currency", lang)
    try:
        return f"{int(Decimal(str(value or 0))):,}".replace(",", " ") + f" {cur}"
    except Exception:  # noqa: BLE001
        return f"{value} {cur}"


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


def build_daily_report(for_date: dt.date | None = None, lang: str = "ru") -> str:
    """Markdown-formatted summary for the given local date (default: today)."""
    tz = timezone.get_current_timezone()
    today = for_date or timezone.localdate()

    today_start = dt.datetime.combine(today, dt.time(0, 0), tzinfo=tz)
    today_end = today_start + dt.timedelta(days=1)
    y_start = today_start - dt.timedelta(days=1)

    today_a = _aggregate_window(today_start, today_end)
    yest_a = _aggregate_window(y_start, today_start)

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
    diff_label = t("rep_diff_label", lang, amount=_fmt_money(abs(diff), lang), emoji=diff_emoji)

    lines: list[str] = [
        t("rep_header", lang, date=today.strftime("%d.%m.%Y")),
        "",
        t("rep_today", lang, total=_fmt_money(today_a["total"], lang), count=today_a["count"]),
        t("rep_yest", lang, total=_fmt_money(yest_a["total"], lang), count=yest_a["count"]),
        t("rep_diff", lang, diff=diff_label),
        "",
    ]

    if op_rows:
        lines.append(t("rep_operators", lang))
        for r in op_rows:
            lines.append(
                f"  • {r['operator__full_name']}: {_fmt_money(r['total'], lang)} ({r['count']})"
            )
    else:
        lines.append(t("rep_no_ops", lang))
    lines.append("")

    if partner_rows:
        lines.append(t("rep_partners", lang))
        for r in partner_rows:
            lines.append(
                f"  • {r['partner__name']}: {_fmt_money(r['total'], lang)} ({r['count']})"
            )
    else:
        lines.append(t("rep_no_partners", lang))

    return "\n".join(lines)

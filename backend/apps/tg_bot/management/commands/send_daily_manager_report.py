"""
Nightly manager report — pushed as a Telegram DM to every subscribed
manager/team-lead. Runs from the scheduler container at 23:30 local.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import logging

from django.core.management.base import BaseCommand
from django.utils import timezone

from apps.leads.models import Lead
from apps.leads.selectors import (
    active_lead_status_codes,
    terminal_lead_status_codes,
)
from apps.operators.models import Operator, OperatorStatus
from apps.sales.models import Sale
from apps.tg_bot.models import BotSubscription
from apps.users.models import Role

logger = logging.getLogger("tg_bot.daily_report")


def _fmt_uzs(n: int | float) -> str:
    return f"{int(n or 0):,}".replace(",", " ")


def _build_report(day: dt.date) -> str:
    tz = timezone.get_current_timezone()
    day_start = dt.datetime.combine(day, dt.time.min, tzinfo=tz)
    day_end = dt.datetime.combine(day, dt.time.max, tzinfo=tz)

    # Sales for the day
    sales_qs = Sale.objects.filter(
        is_deleted=False, is_returned=False, status="confirmed",
        sold_at__gte=day_start, sold_at__lte=day_end,
    )
    total_revenue = sum((s.amount - s.discount) for s in sales_qs) or 0
    sales_count = sales_qs.count()

    # Leads created today
    leads_today = Lead.objects.filter(created_at__gte=day_start, created_at__lte=day_end).count()

    # Per-operator breakdown for today
    active_ops = list(Operator.objects.filter(status=OperatorStatus.ACTIVE).order_by("id"))
    terminal = set(terminal_lead_status_codes())
    workable = list(set(active_lead_status_codes()) - terminal)

    op_lines = []
    for op in active_ops:
        received = Lead.objects.filter(
            operator=op, created_at__gte=day_start, created_at__lte=day_end
        ).count()
        working = Lead.objects.filter(
            operator=op, status__in=workable, postponed_at__isnull=True,
        ).count()
        sold = sales_qs.filter(operator_lines__operator=op).distinct().count()
        sold_amt = 0
        for s in sales_qs.filter(operator_lines__operator=op).distinct():
            sold_amt += int(s.amount - s.discount)
        op_lines.append(f"  • <b>{op.full_name}</b>: +{received} · в работе {working} · продано {sold} на {_fmt_uzs(sold_amt)} сум")

    lines = [
        f"📊 <b>Итоги дня — {day.strftime('%d.%m.%Y')}</b>",
        "",
        f"💰 Продажи: <b>{sales_count}</b> на <b>{_fmt_uzs(total_revenue)} сум</b>",
        f"📥 Новых лидов: <b>{leads_today}</b>",
        f"👥 Активных операторов: <b>{len(active_ops)}</b>",
        "",
        "<b>По операторам:</b>",
        *op_lines,
    ]
    return "\n".join(lines)


async def _send_dm(user_id: int, text: str) -> bool:
    from django.conf import settings

    token = getattr(settings, "TELEGRAM_BOT_TOKEN", "")
    if not token or not user_id:
        return False
    try:
        from aiogram import Bot
    except ImportError:
        logger.warning("aiogram missing — DM skipped")
        return False
    bot = Bot(token=token)
    try:
        await bot.send_message(user_id, text, parse_mode="HTML")
        return True
    except Exception as exc:
        logger.warning("daily report DM to %s failed: %s", user_id, exc)
        return False
    finally:
        try:
            await bot.session.close()
        except Exception:
            pass


class Command(BaseCommand):
    help = "Send the nightly manager summary to every subscribed manager/team-lead."

    def add_arguments(self, parser):
        parser.add_argument("--date", type=str, default=None,
                            help="YYYY-MM-DD; default is today (local).")

    def handle(self, *args, **opts):
        d = opts.get("date")
        day = dt.datetime.strptime(d, "%Y-%m-%d").date() if d else timezone.localdate()
        text = _build_report(day)
        subs = list(
            BotSubscription.objects.filter(
                user__profile__role__in=(Role.MANAGER, Role.TEAM_LEAD, Role.SUPERADMIN),
                blocked_at__isnull=True,
            ).exclude(chat_id__isnull=True)
        )
        self.stdout.write(f"sending to {len(subs)} managers")
        sent = 0
        for sub in subs:
            try:
                ok = asyncio.run(_send_dm(sub.chat_id, text))
                if ok:
                    sent += 1
            except Exception as exc:
                logger.warning("send failed sub=%s: %s", sub.id, exc)
        self.stdout.write(self.style.SUCCESS(f"delivered {sent}/{len(subs)}"))

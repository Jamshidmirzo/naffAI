"""
3-hourly operator leaderboard DM.

Runs from a host cron (see ``deploy/cron/naffai-3h-leaderboard.cron``) at
10:00 / 13:00 / 16:00 / 19:00 Asia/Tashkent (05:00, 08:00, 11:00, 14:00 UTC).
Pulls today's snapshot from :func:`apps.analytics.selectors.lead_stats_snapshot`,
renders a top-10 leaderboard sorted by ``unique_leads_touched`` DESC, and
sends the message as a Telegram DM to every active
:class:`BotSubscription`.

Bilingual: subscriptions with ``language="uz"`` get the Uzbek variant, all
others get Russian.

CLI flags:

  --dry-run        Render the report and print it to stdout without touching
                   the Telegram Bot API. Nothing is persisted / no messages
                   go out.
  --min-hour <N>   Skip sending if the current local hour < N. Default 10.
                   Guard for hosts whose cron TZ we don't control — belt +
                   suspenders on top of the UTC-cron schedule.
  --max-hour <N>   Skip sending if the current local hour > N. Default 19.

Exit code is always 0 (a broken TG token or one blocked chat shouldn't fail
the cron job). Actual send failures are logged and counted in the summary.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import logging

from django.core.management.base import BaseCommand
from django.utils import timezone

from apps.analytics.selectors import lead_stats_snapshot
from apps.tg_bot.selectors import bot_broadcast_recipients

logger = logging.getLogger("tg_bot.leaderboard_3h")


# --- month name localisations (RU + UZ short forms) --------------------

_MONTHS_RU = [
    "янв", "фев", "мар", "апр", "май", "июн",
    "июл", "авг", "сен", "окт", "ноя", "дек",
]
_MONTHS_UZ = [
    "yan", "fev", "mar", "apr", "may", "iyun",
    "iyul", "avg", "sen", "okt", "noy", "dek",
]


def _short_date(day: dt.date, *, lang: str) -> str:
    """DD MMM in the requested language."""
    months = _MONTHS_UZ if lang == "uz" else _MONTHS_RU
    return f"{day.day} {months[day.month - 1]}"


# --- report rendering --------------------------------------------------


def _sort_leaderboard(rows: list[dict]) -> list[dict]:
    """
    Order operators for the leaderboard:
      1) unique_leads_touched DESC (main KPI — who worked today),
      2) sold_total DESC (tie-break for hard workers who closed more),
      3) calls_total DESC (very quiet tie-break).
    """
    return sorted(
        rows,
        key=lambda r: (
            int(r.get("unique_leads_touched", 0) or 0),
            int(r.get("sold_total", 0) or 0),
            int(r.get("calls_total", 0) or 0),
        ),
        reverse=True,
    )


def _build_report(
    snapshot: dict,
    *,
    now: dt.datetime,
    lang: str,
    top_n: int = 10,
) -> str:
    """
    Assemble the HTML message body from a `lead_stats_snapshot` result.

    Empty state (no operator with any touched leads):
      "Пока нет обзвонов" / "Hozircha faoliyat yo'q".
    """
    rows = _sort_leaderboard(snapshot.get("by_operator") or [])
    # Only surface operators that actually did something today — a 0/0/0
    # row is noise in an operational leaderboard.
    active_rows = [r for r in rows if int(r.get("unique_leads_touched", 0) or 0) > 0]

    hh_mm = now.strftime("%H:%M")
    day_str = _short_date(now.date(), lang=lang)

    total_calls = sum(int(r.get("calls_total", 0) or 0) for r in rows)
    total_sold = sum(int(r.get("sold_total", 0) or 0) for r in rows)

    if lang == "uz":
        header = f"📊 <b>3 soatlik hisobot · {hh_mm}</b>"
        subhdr = f"Bugungi kunga, {day_str}"
        top_label = "🏆 Eng faol operatorlar:"
        empty_line = "Hozircha faoliyat yo'q"
        calls_word = "obzvon"
        sold_word = "sotuv"
        total_calls_lbl = "📞 Jami qo'ng'iroqlar"
        total_sold_lbl = "💰 Jami sotuvlar"
        statuses_label = "📋 Statuslar:"
    else:
        header = f"📊 <b>Оперативная сводка · {hh_mm}</b>"
        subhdr = f"За сегодня, {day_str}"
        top_label = "🏆 Топ операторов:"
        empty_line = "Пока нет обзвонов"
        calls_word = "обзвонил"
        sold_word = "продажи"
        total_calls_lbl = "📞 Всего звонков"
        total_sold_lbl = "💰 Всего продаж"
        statuses_label = "📋 Статусы:"

    # Status catalog (code → label+emoji) is on the snapshot's by_status list;
    # rebuild a fast lookup so we can render per-operator breakdown below.
    status_meta: dict[str, dict] = {}
    for s in snapshot.get("by_status") or []:
        code = s.get("code") or ""
        if code:
            status_meta[code] = {
                "label": (s.get("label_uz") if lang == "uz" else s.get("label_ru")) or code,
                "emoji": (s.get("emoji") or "").strip(),
            }

    lines = [header, subhdr, "", top_label]
    if not active_rows:
        lines.append(empty_line)
    else:
        for i, r in enumerate(active_rows[:top_n], start=1):
            name = (r.get("operator_name") or "—").strip() or "—"
            calls = int(r.get("unique_leads_touched", 0) or 0)
            sold = int(r.get("sold_total", 0) or 0)
            lines.append(f"<b>{i}. {name}</b> — {calls} {calls_word}, {sold} {sold_word}")
            # Per-operator status breakdown (DESC by count).
            op_statuses = r.get("by_status") or {}
            sorted_codes = sorted(
                op_statuses.items(), key=lambda kv: int(kv[1] or 0), reverse=True
            )
            for code, cnt in sorted_codes:
                if int(cnt or 0) <= 0:
                    continue
                meta = status_meta.get(code) or {"label": code, "emoji": ""}
                emoji = f"{meta['emoji']} " if meta["emoji"] else ""
                lines.append(f"   {emoji}{meta['label']}: <b>{int(cnt)}</b>")
            lines.append("")  # blank line between operators

    # Overall statuses breakdown (across all operators, top 10).
    by_status = snapshot.get("by_status") or []
    status_rows = sorted(
        (s for s in by_status if int(s.get("count", 0) or 0) > 0),
        key=lambda s: int(s.get("count", 0) or 0),
        reverse=True,
    )[:10]
    if status_rows:
        lines.append(statuses_label)
        for s in status_rows:
            label = (s.get("label_uz") if lang == "uz" else s.get("label_ru")) or s.get("code") or "—"
            emoji = (s.get("emoji") or "").strip()
            prefix = f"{emoji} " if emoji else "• "
            lines.append(f"{prefix}{label}: <b>{int(s.get('count', 0) or 0)}</b>")
        lines.append("")

    lines.append(f"{total_calls_lbl}: <b>{total_calls}</b>")
    lines.append(f"{total_sold_lbl}: <b>{total_sold}</b>")
    return "\n".join(lines)


# --- IO layer ----------------------------------------------------------


async def _send_dm(chat_id: int, text: str) -> tuple[bool, str]:
    """
    Deliver `text` to `chat_id` via aiogram. Returns (ok, error_str).

    Kept as a bare async coroutine (no ORM) so it's safe to await from
    inside an event loop — Django's SynchronousOnlyOperation only bites
    when ORM access happens in the loop.
    """
    from django.conf import settings

    token = getattr(settings, "TELEGRAM_BOT_TOKEN", "")
    if not token or not chat_id:
        return False, "missing token or chat_id"
    try:
        from aiogram import Bot
    except ImportError:
        return False, "aiogram missing"
    bot = Bot(token=token)
    try:
        await bot.send_message(chat_id, text, parse_mode="HTML")
        return True, ""
    except Exception as exc:
        return False, str(exc)
    finally:
        try:
            await bot.session.close()
        except Exception:
            pass


# --- command entrypoint ------------------------------------------------


class Command(BaseCommand):
    help = (
        "Send a 3-hour operator leaderboard DM (top 10 by unique leads "
        "touched today) to every active BotSubscription. Bilingual RU/UZ."
    )

    def add_arguments(self, parser):
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="Print the report to stdout without sending any Telegram DMs.",
        )
        parser.add_argument(
            "--min-hour",
            type=int,
            default=10,
            help=(
                "Skip if local (Asia/Tashkent) hour < min-hour. Guards against "
                "misconfigured cron TZs. Default 10."
            ),
        )
        parser.add_argument(
            "--max-hour",
            type=int,
            default=19,
            help=(
                "Skip if local (Asia/Tashkent) hour > max-hour. Default 19."
            ),
        )

    def handle(self, *args, **opts):
        min_hour = int(opts["min_hour"])
        max_hour = int(opts["max_hour"])
        dry_run = bool(opts["dry_run"])

        now = timezone.localtime()
        if now.hour < min_hour or now.hour > max_hour:
            self.stdout.write(
                f"skip: local hour {now.hour} outside [{min_hour}, {max_hour}]"
            )
            return

        # Snapshot for today (localdate 00:00 … 23:59:59) — same shape the
        # /leads-stats API uses when the FE sends `date_from=date_to=today`.
        tz = timezone.get_current_timezone()
        today = now.date()
        date_from = dt.datetime.combine(today, dt.time.min, tzinfo=tz)
        date_to = dt.datetime.combine(today, dt.time.max, tzinfo=tz)

        # IMPORTANT: pull snapshot + subscriptions in sync mode BEFORE we hop
        # into asyncio.run(), otherwise the ORM raises SynchronousOnlyOperation
        # when a coroutine touches the DB from inside the event loop.
        snapshot = lead_stats_snapshot(date_from=date_from, date_to=date_to)
        # 2026-08-28: switched from raw `is_active` filter to the
        # `bot_broadcast_recipients()` selector so each subscription's
        # `receives_broadcasts` toggle is honoured. Operators who only
        # need personal DMs (callback reminders, /find results) stay
        # subscribed but don't receive the manager digest anymore.
        subs = list(bot_broadcast_recipients().exclude(chat_id__isnull=True))

        # Render once per language — subscriptions with the same lang share
        # the same rendered text (saves N-1 renders per broadcast).
        text_by_lang: dict[str, str] = {}
        for sub in subs:
            lang = (sub.language or "ru").lower()
            if lang not in text_by_lang:
                text_by_lang[lang] = _build_report(snapshot, now=now, lang=lang)
        # Also render RU when the queue is empty (nothing to send) so
        # --dry-run always shows something for the operator running it.
        if not text_by_lang:
            text_by_lang["ru"] = _build_report(snapshot, now=now, lang="ru")

        if dry_run:
            for lang, text in text_by_lang.items():
                self.stdout.write(f"--- lang={lang} ---")
                self.stdout.write(text)
                self.stdout.write("")
            self.stdout.write(
                self.style.SUCCESS(f"dry-run: would send to {len(subs)} chats")
            )
            return

        sent = 0
        errors = 0
        for sub in subs:
            lang = (sub.language or "ru").lower()
            text = text_by_lang.get(lang) or text_by_lang.get("ru") or ""
            try:
                ok, err = asyncio.run(_send_dm(sub.chat_id, text))
            except Exception as exc:  # pragma: no cover — asyncio.run itself failing
                ok, err = False, str(exc)
            if ok:
                sent += 1
            else:
                errors += 1
                logger.warning(
                    "3h leaderboard DM failed sub=%s chat=%s: %s",
                    sub.id,
                    sub.chat_id,
                    err,
                )

        self.stdout.write(
            self.style.SUCCESS(
                f"delivered {sent}/{len(subs)} (errors={errors})"
            )
        )

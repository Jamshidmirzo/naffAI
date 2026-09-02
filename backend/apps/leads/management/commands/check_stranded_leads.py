"""
Проактивная гигиена: раз в сутки считаем, сколько лидов система
пометила как `system-lost` за прошедшие 24 часа. Если счётчик выше
порога — шлём superadmin'ам алерт в Telegram.

История: раньше эта команда считала два пула — `stranded` (non-terminal
на inactive-операторах) и `needs_review > 7 дней`. После введения
system-lost:
  * stranded не копится (`operator_deactivate` сразу помечает touched
    как system-lost);
  * needs_review-сироты тоже помечаются командой
    `mark_stranded_as_system_lost` (одноразово + ловля новых через
    `check_stranded_leads`).

Значит новая метрика — «сколько лидов за сутки ушло в system-lost».
Если после массовой миграции 556 → 0 счётчик снова полез вверх, значит
что-то системное сломалось (например, sheet-строки массово идут с
битым phone, или уволили целый пул). Алерт зовёт superadmin разобраться.

Флаг `--dry-run` — печатает цифры в stdout, но не шлёт Telegram.

Регистрируем в docker-compose как отдельный шаг ops-nightly (23:30
Tashkent) — после `release_stale_leads` и до `send_daily_manager_report`.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import os

from django.conf import settings
from django.core.management.base import BaseCommand
from django.utils import timezone

from apps.leads.models import Lead
from apps.leads.selectors import (
    KNOWN_LOST_REASONS,
    needs_review_leads,
    stranded_on_inactive_operators,
)


class Command(BaseCommand):
    help = (
        "Проактивная гигиена «пропавших лидов»: алерт superadmin'ам, если "
        "за сутки system-lost превышает порог, а также контроль остаточных "
        "stranded / needs_review-old."
    )

    def add_arguments(self, parser):
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="Только stdout, без Telegram-алерта.",
        )
        parser.add_argument(
            "--threshold",
            type=int,
            default=None,
            help="Порог. Иначе — env STRANDED_ALERT_THRESHOLD (default 20).",
        )
        parser.add_argument(
            "--window-hours",
            type=int,
            default=24,
            help="Окно, за которое считаем свежие system-lost (default 24 часа).",
        )

    def handle(self, *args, **opts):
        dry_run = bool(opts.get("dry_run"))
        threshold = opts.get("threshold")
        if threshold is None:
            try:
                threshold = int(os.environ.get("STRANDED_ALERT_THRESHOLD", "20"))
            except ValueError:
                threshold = 20
        window_hours = int(opts.get("window_hours") or 24)

        cutoff_iso = (
            timezone.localtime(timezone.now() - dt.timedelta(hours=window_hours))
            .isoformat(timespec="seconds")
        )

        # Свежие system-lost — метрика #1. Читаем лексикографически по
        # `metadata->lost_at` (ISO-строка), что работает пока TZ offset
        # одинаковый (у нас Asia/Tashkent).
        recent_lost = Lead.objects.filter(
            metadata__lost_reason__isnull=False,
            metadata__lost_at__gte=cutoff_iso,
        ).count()

        # По reason'у — какая именно причина растёт (invalid_phone
        # vs stranded_on_inactive_operator).
        recent_by_reason: dict[str, int] = {}
        for reason in KNOWN_LOST_REASONS:
            recent_by_reason[reason] = Lead.objects.filter(
                metadata__lost_reason=reason,
                metadata__lost_at__gte=cutoff_iso,
            ).count()

        # Метрики #2/#3 — остаточные пулы. Идеал = 0 (mark_stranded_as_system_lost
        # уже прошёл на проде). Если рост — значит новые случаи, которые
        # `operator_deactivate` не поймал.
        stranded_leftover = stranded_on_inactive_operators().count()
        cutoff_days = timezone.now() - dt.timedelta(days=7)
        needs_review_old_count = (
            needs_review_leads().filter(created_at__lt=cutoff_days).count()
        )

        self.stdout.write(
            f"[check-stranded] recent_system_lost({window_hours}h)={recent_lost} "
            f"stranded_leftover={stranded_leftover} "
            f"needs_review>7d={needs_review_old_count} threshold={threshold}"
        )
        if recent_by_reason:
            for reason, n in sorted(recent_by_reason.items()):
                self.stdout.write(f"[check-stranded]   {reason}: {n}")

        # Silent path — все ниже порога.
        if (
            recent_lost < threshold
            and stranded_leftover < threshold
            and needs_review_old_count < threshold
        ):
            self.stdout.write(self.style.SUCCESS("[check-stranded] всё в порядке"))
            return

        body_lines = ["⚠️ <b>Пропавшие лиды копятся</b>"]
        if recent_lost >= threshold:
            body_lines.append(
                f"• за {window_hours}h ушли в system-lost: <b>{recent_lost}</b>"
            )
            for reason, n in sorted(recent_by_reason.items()):
                if n:
                    body_lines.append(f"    — {reason}: {n}")
        if stranded_leftover >= threshold:
            body_lines.append(
                f"• остаточные stranded (non-terminal на inactive): "
                f"<b>{stranded_leftover}</b>"
            )
        if needs_review_old_count >= threshold:
            body_lines.append(
                f"• needs_review > 7 дней: <b>{needs_review_old_count}</b>"
            )
        body_lines.append("")
        body_lines.append(
            "Проверь /leads/system-lost (superadmin) — таблица со всеми "
            "автозакрытиями. Если рост системный, запусти "
            "<code>mark_stranded_as_system_lost --dry-run</code>."
        )
        body = "\n".join(body_lines)

        if dry_run:
            self.stdout.write("[check-stranded] dry-run — Telegram не шлём")
            self.stdout.write(body)
            return

        sent = asyncio.run(_broadcast_to_superadmins(body))
        self.stdout.write(f"[check-stranded] отправлено superadmin'ам: {sent}")


async def _broadcast_to_superadmins(body: str) -> int:
    """
    Отправить `body` всем Profile.telegram_user_id, привязанным к
    role=SUPERADMIN. Возвращает число успешных доставок.

    Тот же путь, что использует crash_watch_loop в runner.py: короткий
    aiogram Bot() per invocation, без переиспользования сессии — команду
    зовут раз в сутки, экономия не имеет смысла.
    """
    token = getattr(settings, "TELEGRAM_BOT_TOKEN", "")
    if not token:
        return 0
    try:
        from aiogram import Bot
    except ImportError:
        return 0

    from asgiref.sync import sync_to_async

    def _load_chat_ids() -> list[int]:
        from apps.users.models import Profile, Role

        ids = list(
            Profile.objects.filter(
                role=Role.SUPERADMIN, telegram_user_id__isnull=False
            ).values_list("telegram_user_id", flat=True)
        )
        return [int(i) for i in dict.fromkeys(ids) if i]

    chat_ids = await sync_to_async(_load_chat_ids)()
    if not chat_ids:
        return 0

    bot = Bot(token=token)
    sent = 0
    try:
        for chat_id in chat_ids:
            try:
                await bot.send_message(chat_id, body, parse_mode="HTML")
                sent += 1
            except Exception:
                # Индивидуальные фейлы (юзер заблочил бота и т.п.) не
                # ломают рассылку остальным.
                continue
    finally:
        # У aiogram 3.x нет обязательного close, но защитимся на случай
        # старых версий.
        close = getattr(bot, "session", None)
        if close is not None:
            try:
                await bot.session.close()
            except Exception:
                pass
    return sent

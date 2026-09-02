"""
Проактивная гигиена: раз в сутки считаем «пропавших лидов» и алертим
superadmin'ам в Telegram, если счётчики выше порога.

Считаем два потенциально проблемных пула:
  * stranded — non-terminal лиды на inactive-операторах (тот же селектор,
    что использует rescue_stranded_leads).
  * needs_review-older-than-7-days — сироты в needs_review, зависшие
    в очереди на ручной триаж больше недели. Обычно битые sheet-строки,
    которые никто не разобрал.

Оба порога управляются одной env-переменной `STRANDED_ALERT_THRESHOLD`
(default 20). Ниже порога — silent (не шумим лишний раз).

Флаг `--dry-run` — печатаем цифры в stdout, но НЕ шлём Telegram. Нужен
для тестирования и для регистрации в scheduler'е без риска спама.

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

from apps.leads.selectors import (
    needs_review_leads,
    stranded_on_inactive_operators,
)


class Command(BaseCommand):
    help = (
        "Проактивная гигиена «пропавших лидов»: алерт superadmin'ам, если "
        "stranded или needs_review-old превышают порог."
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

    def handle(self, *args, **opts):
        dry_run = bool(opts.get("dry_run"))
        threshold = opts.get("threshold")
        if threshold is None:
            try:
                threshold = int(os.environ.get("STRANDED_ALERT_THRESHOLD", "20"))
            except ValueError:
                threshold = 20

        stranded_count = stranded_on_inactive_operators().count()

        # needs_review старше 7 дней. `created_at` — когда сирота попала в БД.
        cutoff = timezone.now() - dt.timedelta(days=7)
        needs_review_old_count = (
            needs_review_leads().filter(created_at__lt=cutoff).count()
        )

        self.stdout.write(
            f"[check-stranded] stranded={stranded_count} "
            f"needs_review>7d={needs_review_old_count} threshold={threshold}"
        )

        # Silent path — оба ниже порога.
        if stranded_count < threshold and needs_review_old_count < threshold:
            self.stdout.write(self.style.SUCCESS("[check-stranded] всё в порядке"))
            return

        body_lines = ["⚠️ <b>Пропавшие лиды копятся</b>"]
        if stranded_count >= threshold:
            body_lines.append(
                f"• зависли на уволенных: <b>{stranded_count}</b>"
            )
        if needs_review_old_count >= threshold:
            body_lines.append(
                f"• needs_review > 7 дней: <b>{needs_review_old_count}</b>"
            )
        body_lines.append("")
        body_lines.append(
            "Запусти <code>rescue_stranded_leads --dry-run</code> и посмотри "
            "предпросмотр, потом без флага для применения."
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

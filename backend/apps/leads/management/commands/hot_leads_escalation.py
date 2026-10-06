"""
Watcher для горячих лидов (ТЕЗ).

Правило: лиды из `SheetSource.is_hot=True` при импорте получают
`Lead.hot_until = now + sheet_source.hot_sla_minutes` (по умолчанию 10
минут). Оператор должен тронуть лид до этого дедлайна — любая смена
статуса в `lead_update_status` обнуляет `hot_until`.

Если `hot_until <= now` и лид всё ещё в статусе NEW/ASSIGNED — он
«остыл»: оператор не дотянулся вовремя. Команда:

  1. выбирает все остывшие лиды (hot_until <= now, status in {new, assigned}),
     ещё не эскалированные (metadata.hot_escalated != True);
  2. отправляет ОДИН групповой TG на chat_id 88938071 — с id-ами первых
     5 лидов и их операторами (если >5 — указывает «и ещё N»);
  3. обнуляет hot_until у этих лидов и ставит metadata.hot_escalated = True,
     чтобы следующий тик их не пересобирал.

Docker-service `hot-leads-watch` крутит эту команду каждые 60с.

Флаг `--dry-run` — считает и печатает, что бы отправил и обнулил,
но не трогает БД и не шлёт TG.
"""

from __future__ import annotations

import asyncio
import logging

from django.conf import settings
from django.core.management.base import BaseCommand
from django.utils import timezone

from apps.leads.models import Lead

logger = logging.getLogger("leads.hot_escalation")

# Fixed owner chat per plan (не superadmin'ы — конкретный владелец).
OWNER_TG_CHAT_ID = 88938071


class Command(BaseCommand):
    help = (
        "Эскалировать горячих лидов (ТЕЗ), которые остыли без контакта "
        "оператора. Шлёт один групповой TG владельцу (88938071) и обнуляет "
        "hot_until. Запускается watcher-сервисом каждые 60с."
    )

    def add_arguments(self, parser):
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="Только stdout — не шлём TG и не обновляем лиды.",
        )

    def handle(self, *args, **opts):
        dry_run = bool(opts.get("dry_run"))
        now = timezone.now()

        # Выбираем остывших горячих. status__in гарантирует, что лид ещё
        # «новый» для оператора — любая смена статуса сбросила бы hot_until
        # заранее. Защита от повторной эскалации — обнуление hot_until
        # после отправки: следующий тик уже не попадёт в filter.
        #
        # NB: раньше здесь был `.exclude(metadata__hot_escalated=True)` —
        # но для лидов с metadata={} jsonb-оператор `metadata->'hot_escalated'`
        # возвращает NULL, и `NOT (NULL = jsonb(true))` = NULL → WHERE
        # отфильтровывает их. Полагаемся на hot_until-занул вместо этого.
        qs = (
            Lead.objects.filter(
                hot_until__lte=now,
                hot_until__isnull=False,
                status__in=["new", "assigned"],
            )
            .select_related("operator")
            .order_by("hot_until")
        )

        cold_leads = list(qs[:200])  # safety-cap: больше 200 за тик — явно баг
        if not cold_leads:
            self.stdout.write(
                self.style.SUCCESS(f"[hot-leads-escalation] now={now.isoformat()} cold=0")
            )
            return

        self.stdout.write(
            f"[hot-leads-escalation] now={now.isoformat()} cold={len(cold_leads)}"
        )

        body = _build_report_body(cold_leads)

        if dry_run:
            self.stdout.write("[hot-leads-escalation] --dry-run — TG не шлём, БД не трогаем")
            self.stdout.write("---8<--- preview ---8<---")
            self.stdout.write(body)
            self.stdout.write("---8<--- end ---8<---")
            for lead in cold_leads:
                op_name = (
                    lead.operator.full_name if lead.operator_id and lead.operator else "—"
                )
                self.stdout.write(
                    f"[hot-leads-escalation] would_escalate lead={lead.id} op={op_name}"
                )
            return

        # 1) Отправка TG — делаем до записи в БД, чтобы при сбое Telegram
        #    hot_until у лидов остался и следующий тик попробует ещё раз.
        sent = asyncio.run(_send_tg_report(body))
        if sent == 0:
            self.stdout.write(
                self.style.WARNING(
                    "[hot-leads-escalation] TG не доставлен — не помечаем лиды эскалированными"
                )
            )
            return

        # 2) Пометка «эскалировано» + обнуление hot_until. По одному лиду,
        #    чтобы корректно слить metadata (bulk_update на JSONField с
        #    merge — отдельная история, здесь объёмы десятки лидов за тик,
        #    row-at-a-time надёжнее).
        processed = 0
        for lead in cold_leads:
            meta = dict(lead.metadata or {})
            meta["hot_escalated"] = True
            meta["hot_escalated_at"] = timezone.now().isoformat()
            lead.metadata = meta
            lead.hot_until = None
            lead.save(update_fields=["metadata", "hot_until", "updated_at"])
            processed += 1

        self.stdout.write(
            self.style.SUCCESS(
                f"[hot-leads-escalation] escalated={processed} sent_tg={sent}"
            )
        )


def _build_report_body(cold_leads: list[Lead]) -> str:
    """
    Собрать HTML-тело для TG. Показываем первые 5 лидов (id + оператор),
    остальных сворачиваем в «и ещё N».
    """
    total = len(cold_leads)
    head = cold_leads[:5]
    rest = total - len(head)

    lines = [f"🔥 <b>Остыло {total} горячих лид{_plural_ru(total)}</b>"]
    lines.append("")
    for lead in head:
        op_name = (
            lead.operator.full_name if lead.operator_id and lead.operator else "—"
        )
        name = (lead.full_name or "").strip() or "без имени"
        lines.append(f"• #{lead.id} {name} — оператор: <b>{op_name}</b>")
    if rest > 0:
        lines.append(f"… и ещё <b>{rest}</b>")
    lines.append("")
    lines.append(
        "Это горячие шиты (ТЕЗ) — клиенты оставили заявку и ждали звонка. "
        "SLA истёк, никто не ответил."
    )
    return "\n".join(lines)


def _plural_ru(n: int) -> str:
    """Склонение: 1 лид, 2-4 лида, 5+ лидов."""
    if n % 10 == 1 and n % 100 != 11:
        return "а"
    if 2 <= n % 10 <= 4 and not (12 <= n % 100 <= 14):
        return "ов"  # лид-ов — согласуется с "горячих"
    return "ов"


async def _send_tg_report(body: str) -> int:
    """
    Отправить `body` на фиксированный chat_id владельца.
    Возвращает 1 при успехе, 0 при любом фейле.
    """
    token = getattr(settings, "TELEGRAM_BOT_TOKEN", "") or ""
    if not token:
        logger.warning("TELEGRAM_BOT_TOKEN пустой — hot-escalation TG не отправлена")
        return 0
    try:
        from aiogram import Bot
    except ImportError:
        logger.warning("aiogram не установлен — hot-escalation TG не отправлена")
        return 0

    bot = Bot(token=token)
    try:
        try:
            await bot.send_message(OWNER_TG_CHAT_ID, body, parse_mode="HTML")
            return 1
        except Exception:
            logger.exception("hot-leads-escalation: TG send failed")
            return 0
    finally:
        session = getattr(bot, "session", None)
        if session is not None:
            try:
                await bot.session.close()
            except Exception:
                pass

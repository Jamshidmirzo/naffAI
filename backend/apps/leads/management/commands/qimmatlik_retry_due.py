"""
Отложенный ретрай лидов со статусом `qimmatlik_qildi`.

Правило (см. `_next_qimmatlik_retry_at` в apps.leads.services):

  * статус выставлен ДО 13:00 (Asia/Tashkent) → retry сегодня в 16:00;
  * статус выставлен В или ПОСЛЕ 13:00 → retry завтра в 09:30.

Метка времени лежит в `Lead.metadata["qimmatlik_retry_at"]` (ISO-строка
с TZ-offset). Эта команда каждые 10 минут (docker service
`qimmatlik-retry-watch`) выбирает лиды, у которых `retry_at <= now`, и
делегирует переуступку `lead_qimmatlik_retry`:

  * найдётся свежий оператор → передадим лид ему (source =
    QIMMATLIK_RETRY), очистим `retry_at`;
  * все операторы уже пробовали → закроем лид как LOST, очистим
    `retry_at`.

Идемпотентно: `_clear_qimmatlik_retry_metadata` внутри
`lead_qimmatlik_retry` снимает ключ до/после действия, поэтому повторный
запуск через 10 минут ничего не найдёт.

--dry-run — не пишет в БД, только показывает сколько лидов было бы
обработано (и по каким id).
"""

from __future__ import annotations

import datetime as dt
import logging

from django.core.management.base import BaseCommand
from django.utils import timezone

from apps.leads.models import Lead
from apps.leads.services import _clear_qimmatlik_retry_metadata, lead_qimmatlik_retry

logger = logging.getLogger("leads.qimmatlik_retry")


class Command(BaseCommand):
    help = (
        "Обработать лиды qimmatlik_qildi, у которых наступило время "
        "отложенного ретрая (metadata.qimmatlik_retry_at <= now)."
    )

    def add_arguments(self, parser):
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="Показать сколько лидов обработалось бы, не менять БД.",
        )

    def handle(self, *args, **opts):
        dry_run = bool(opts.get("dry_run"))
        now_local = timezone.localtime()

        # На уровне БД отфильтруем только тех, у кого ключ существует.
        # Само сравнение времени делаем в Python — retry_at сохранён как
        # ISO-строка (JSONField), надёжнее распарсить, чем полагаться на
        # лексикографический lte по ISO-8601 (offset и микросекунды могут
        # разниться, а также null-байты и т.п.).
        qs = (
            Lead.objects.filter(
                status="qimmatlik_qildi",
                metadata__qimmatlik_retry_at__isnull=False,
            )
            .only("id", "status", "metadata", "operator_id")
            .order_by("id")
        )

        due_ids: list[int] = []
        skipped_bad_iso: list[int] = []

        for lead in qs.iterator():
            raw = (lead.metadata or {}).get("qimmatlik_retry_at")
            if not raw:
                continue
            parsed = _parse_iso_local(raw)
            if parsed is None:
                # Битая ISO-строка — уберём ключ, иначе будем спотыкаться о неё
                # на каждом тике. В dry-run просто отметим.
                skipped_bad_iso.append(lead.id)
                if not dry_run:
                    _clear_qimmatlik_retry_metadata(lead)
                continue
            if parsed <= now_local:
                due_ids.append(lead.id)

        self.stdout.write(
            f"[qimmatlik-retry] now={now_local.isoformat()} "
            f"due={len(due_ids)} bad_iso={len(skipped_bad_iso)}"
        )

        if dry_run:
            for lead_id in due_ids:
                self.stdout.write(f"[qimmatlik-retry] dry-run would_retry lead={lead_id}")
            return

        processed = 0
        errors = 0
        for lead_id in due_ids:
            fresh = Lead.objects.select_related("operator").filter(pk=lead_id).first()
            if fresh is None:
                continue
            # Оборонительно — статус мог измениться между отбором и
            # обработкой (менеджер вручную перевёл лид в won/lost).
            if fresh.status != "qimmatlik_qildi":
                _clear_qimmatlik_retry_metadata(fresh)
                continue
            try:
                lead_qimmatlik_retry(fresh)
                processed += 1
            except Exception:
                errors += 1
                logger.exception("qimmatlik_retry_due: retry failed lead=%s", lead_id)

        style = self.style.SUCCESS if processed else self.style.NOTICE
        self.stdout.write(
            style(
                f"[qimmatlik-retry] processed={processed} errors={errors} "
                f"skipped_bad_iso={len(skipped_bad_iso)}"
            )
        )


def _parse_iso_local(raw: str) -> dt.datetime | None:
    """
    Распарсить ISO-8601 из metadata и вернуть aware datetime в текущем
    local TZ. Naive-строку доводим до aware через `timezone.make_aware`.
    Возвращаем None, если строку не удалось распарсить.
    """
    try:
        parsed = dt.datetime.fromisoformat(raw)
    except (TypeError, ValueError):
        return None
    if timezone.is_naive(parsed):
        parsed = timezone.make_aware(parsed, timezone.get_current_timezone())
    return timezone.localtime(parsed)

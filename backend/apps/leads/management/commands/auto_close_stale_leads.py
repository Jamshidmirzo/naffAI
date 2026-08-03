"""
Ночной cron: закрыть как `LOST` все non-carry активные лиды операторов,
у которых `updated_at < сегодня 00:00` (Asia/Tashkent).

Правило (см. `stale_leads_for_auto_close`):
  - `updated_at` строго ДО начала текущего локального дня
  - статус — активный (в `active_lead_status_codes()`)
  - статус НЕ carry-over (те переносятся оператору сами)
  - статус НЕ untouched (`new`/`assigned` — свежие, ждут первого контакта)
  - `operator IS NOT NULL`, `postponed_at IS NULL`

Идемпотентно — второй запуск в тот же день ничего не найдёт (лиды уже LOST).

Уважает killswitch `SystemSetting.auto_distribution_enabled` — если менеджер
вырубил авто-раздачу, экшн не делает ничего.
"""

from __future__ import annotations

from django.core.management.base import BaseCommand

from apps.leads.selectors import stale_leads_for_auto_close
from apps.leads.services import leads_auto_close_stale
from apps.operators.models import Operator
from apps.system_settings.selectors import auto_distribution_enabled


class Command(BaseCommand):
    help = (
        "Автозакрытие вчерашних необработанных non-carry лидов оператора "
        "как LOST. Запускается ночью до утренней раздачи."
    )

    def add_arguments(self, parser):
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="Показать сколько лидов закрылось бы, ничего не менять в БД.",
        )
        parser.add_argument(
            "--verbose",
            action="store_true",
            help="Печатать per-operator сводку даже для тех, у кого 0.",
        )

    def handle(self, *args, **opts):
        if not auto_distribution_enabled():
            self.stdout.write(
                "[auto-close] disabled — SystemSetting.auto_distribution_enabled=False"
            )
            return

        dry_run = bool(opts.get("dry_run"))
        verbose = bool(opts.get("verbose"))

        if dry_run:
            counts = leads_auto_close_stale(dry_run=True)
            total = sum(counts.values())
            self.stdout.write(f"[auto-close] dry-run: would close {total} лидов")
        else:
            preview_total = stale_leads_for_auto_close().count()
            self.stdout.write(
                f"[auto-close] отобрано к закрытию: {preview_total}"
            )
            counts = leads_auto_close_stale(dry_run=False)
            total = sum(counts.values())

        if counts:
            op_names = {
                op.id: op.full_name
                for op in Operator.objects.filter(pk__in=counts.keys())
            }
            for op_id, n in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0])):
                name = op_names.get(op_id, f"op#{op_id}")
                self.stdout.write(
                    f"[auto-close] operator={op_id} name={name} closed={n}"
                )
        elif verbose:
            self.stdout.write("[auto-close] нечего закрывать — все обработаны")

        style = self.style.SUCCESS if total else self.style.NOTICE
        self.stdout.write(
            style(f"[auto-close] total {'would_close' if dry_run else 'closed'}: {total}")
        )

"""
Утренняя раздача лидов: все unassigned активные лиды делятся поровну между
активными операторами. Идёт в связке с sync_sheets_leads: сначала тянем
свежие строки из Google Sheets (одноразово), затем распределяем результат.

Запускается docker-сервисом `morning-splitter` в 08:30 Asia/Tashkent
(03:30 UTC). Идемпотентна — повторный запуск в тот же день распределит
только то, что успело добавиться после первого прогона.
"""

from __future__ import annotations

from django.core.management.base import BaseCommand

from apps.leads.services import morning_distribute_leads
from apps.operators.models import Operator


class Command(BaseCommand):
    help = "Утренняя раздача unassigned-лидов поровну по активным операторам."

    def add_arguments(self, parser):
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="Только показать распределение, не писать в БД.",
        )
        parser.add_argument(
            "--seed",
            type=int,
            default=None,
            help="Seed для shuffle операторов — используется в тестах для детерминизма.",
        )
        parser.add_argument(
            "--limit",
            type=int,
            default=None,
            help="Ограничить размер пула (например, --limit 100).",
        )

    def handle(self, *args, **opts):
        counts = morning_distribute_leads(
            dry_run=opts["dry_run"],
            seed=opts.get("seed"),
            limit=opts.get("limit"),
        )
        if not counts:
            self.stdout.write("[morning] нет unassigned-лидов или активных операторов")
            return

        # Подтягиваем имена одним запросом ради человекочитаемого лога.
        names = dict(
            Operator.objects.filter(pk__in=counts.keys()).values_list("id", "full_name")
        )
        total = 0
        for op_id, n in sorted(counts.items()):
            total += n
            self.stdout.write(
                f"[morning] op={op_id} name={names.get(op_id, '?')} count={n}"
            )
        prefix = "[morning] DRY-RUN " if opts["dry_run"] else "[morning] "
        self.stdout.write(self.style.SUCCESS(f"{prefix}total leads distributed: {total}"))

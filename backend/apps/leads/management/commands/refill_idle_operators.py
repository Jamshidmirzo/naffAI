"""
Раз в минуту: для каждого активного оператора с working_count=0
вытягиваем следующую пачку сирот из общего пула. Дополняет
`_run_refill_if_empty` (хук в lead_update_status) — тот срабатывает
только при закрытии лида, а этот watcher забирает случаи, когда
оператор уже пустой, а свежие лиды приходят «сбоку» (sheet-sync,
release_stale_leads).

Запускается docker-сервисом `distribute-watcher` в цикле `sleep 60`.
Идемпотентна: если у оператора уже есть лиды или пул пуст — no-op.
"""

from __future__ import annotations

from django.core.management.base import BaseCommand

from apps.leads.selectors import operator_working_lead_count
from apps.leads.services import refill_operator_leads
from apps.operators.models import Operator, OperatorStatus
from apps.system_settings.selectors import auto_distribution_enabled


class Command(BaseCommand):
    help = (
        "Проходит по активным операторам с 0 работающих лидов и доливает "
        "им следующую пачку из общего пула сирот."
    )

    def add_arguments(self, parser):
        parser.add_argument(
            "--limit",
            type=int,
            default=None,
            help=(
                "Максимум операторов за один проход (по умолчанию — все). "
                "Полезно, если хочется размазать пиковую нагрузку."
            ),
        )
        parser.add_argument(
            "--verbose",
            action="store_true",
            help="Печатать также операторов, которым ничего не досталось.",
        )

    def handle(self, *args, **opts):
        if not auto_distribution_enabled():
            self.stdout.write("[refill] disabled — SystemSetting.auto_distribution_enabled=False")
            return

        limit = opts.get("limit")
        verbose = bool(opts.get("verbose"))

        qs = Operator.objects.filter(status=OperatorStatus.ACTIVE).order_by("id")
        processed = 0
        total_delivered = 0

        for op in qs:
            if limit is not None and processed >= limit:
                break
            processed += 1

            if operator_working_lead_count(op) > 0:
                if verbose:
                    self.stdout.write(f"[refill] op={op.id} name={op.full_name} skip=busy")
                continue

            try:
                leads = refill_operator_leads(operator=op)
            except Exception as exc:  # pragma: no cover — telemetry only
                self.stderr.write(
                    f"[refill] op={op.id} name={op.full_name} error={exc!r}"
                )
                continue

            if leads:
                total_delivered += len(leads)
                self.stdout.write(
                    f"[refill] op={op.id} name={op.full_name} count={len(leads)}"
                )
            elif verbose:
                self.stdout.write(f"[refill] op={op.id} name={op.full_name} pool=empty")

        if total_delivered:
            self.stdout.write(
                self.style.SUCCESS(f"[refill] total delivered: {total_delivered}")
            )

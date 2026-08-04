"""
Раз в минуту: для каждого активного оператора считаем
`need = RR_BATCH_SIZE - working_count` и, если > 0, доливаем `need`
сирот из общего пула. Дополняет continuous-refill хук в
`lead_update_status`: тот срабатывает при закрытии, а этот watcher
подхватывает случаи, когда:
  - оператор пустой (только начал день, ничего не закрывал),
  - working упало «сбоку» (release_stale_leads, ручное перекидывание),
  - в пул подъехали новые сироты (sheet-sync) — доливаем каждому.

Запускается docker-сервисом `distribute-watcher` в цикле `sleep 60`.
Идемпотентна: если у оператора working == target или пул пуст — no-op.
"""

from __future__ import annotations

from django.conf import settings
from django.core.management.base import BaseCommand

from apps.leads.selectors import operator_working_lead_count
from apps.leads.services import refill_operator_leads
from apps.operators.models import Operator, OperatorStatus
from apps.system_settings.selectors import auto_distribution_enabled


class Command(BaseCommand):
    help = (
        "Проходит по активным операторам и доливает каждому лидов "
        "до RR_BATCH_SIZE (по умолчанию 5) из общего пула сирот."
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
        target = int(getattr(settings, "RR_BATCH_SIZE", 5))

        qs = Operator.objects.filter(status=OperatorStatus.ACTIVE).order_by("id")
        processed = 0
        total_delivered = 0

        for op in qs:
            if limit is not None and processed >= limit:
                break
            processed += 1

            current = operator_working_lead_count(op)
            need = target - current
            if need <= 0:
                if verbose:
                    self.stdout.write(
                        f"[refill] op={op.id} name={op.full_name} "
                        f"skip=full working={current}/{target}"
                    )
                continue

            try:
                leads = refill_operator_leads(operator=op, size=need)
            except Exception as exc:  # pragma: no cover — telemetry only
                self.stderr.write(
                    f"[refill] op={op.id} name={op.full_name} error={exc!r}"
                )
                continue

            if leads:
                total_delivered += len(leads)
                self.stdout.write(
                    f"[refill] op={op.id} name={op.full_name} "
                    f"count={len(leads)} need={need} working={current}→{current + len(leads)}"
                )
            elif verbose:
                self.stdout.write(
                    f"[refill] op={op.id} name={op.full_name} "
                    f"pool=empty need={need}"
                )

        if total_delivered:
            self.stdout.write(
                self.style.SUCCESS(f"[refill] total delivered: {total_delivered}")
            )

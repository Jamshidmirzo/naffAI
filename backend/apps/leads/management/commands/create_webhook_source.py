"""
Create (or re-key) a webhook lead source — LeadPixel «Своя CRM» and the like.

    python manage.py create_webhook_source --name "LeadPixel (Meta)" --hot --hot-sla 10 \
        --operators 3,7 --distribution alias_or_rr
    python manage.py create_webhook_source --rotate 12

Prints the intake path `/api/integrations/leads/<token>/` — prepend the
public host (https://naff.flek.uz) and paste it into LeadPixel as
«Адрес приёма лидов (webhook)». The source then shows up in «Таблицы»
like any sheet: operator pool, hot SLA, sales attribution.
"""

from __future__ import annotations

from django.core.management.base import BaseCommand, CommandError

from apps.common.exceptions import ApplicationError
from apps.leads.integrations.webhook.services import (
    webhook_path,
    webhook_source_create,
    webhook_source_rotate_token,
)
from apps.leads.models import DistributionMode, SheetSource, SheetSourceKind
from apps.operators.models import Operator, OperatorStatus


class Command(BaseCommand):
    help = "Create a webhook lead source (or rotate its token) and print the intake URL path."

    def add_arguments(self, parser) -> None:
        parser.add_argument("--name", help="Source name, e.g. «LeadPixel (Meta)».")
        parser.add_argument("--hot", action="store_true", help="Hot source (ТЕЗ SLA).")
        parser.add_argument("--hot-sla", type=int, default=10, help="Hot SLA minutes (1..120).")
        parser.add_argument(
            "--operators",
            default="",
            help="Comma-separated operator ids for the per-source pool (empty = everybody).",
        )
        parser.add_argument(
            "--distribution",
            default=DistributionMode.ALIAS_OR_ROUND_ROBIN,
            choices=list(DistributionMode.values),
            help="Distribution mode (webhook has no alias → round-robin in practice).",
        )
        parser.add_argument("--rotate", type=int, help="Rotate the token of webhook source <id>.")

    def handle(self, *args, **opts) -> None:
        if opts.get("rotate"):
            src = SheetSource.objects.filter(pk=opts["rotate"], kind=SheetSourceKind.WEBHOOK).first()
            if src is None:
                raise CommandError(f"No webhook source with id={opts['rotate']}")
            src = webhook_source_rotate_token(source=src)
            self.stdout.write(self.style.SUCCESS(f"Rotated token of source #{src.id} «{src.name}»"))
            self.stdout.write(webhook_path(src.webhook_token))
            return

        name = (opts.get("name") or "").strip()
        if not name:
            raise CommandError("--name is required (or --rotate <id>)")
        sla = int(opts["hot_sla"])
        if not 1 <= sla <= 120:
            raise CommandError("--hot-sla must be within 1..120")

        op_ids: list[int] = []
        raw_ops = (opts.get("operators") or "").strip()
        if raw_ops:
            try:
                op_ids = [int(x) for x in raw_ops.split(",") if x.strip()]
            except ValueError as exc:
                raise CommandError("--operators must be comma-separated ids") from exc
            found = set(
                Operator.objects.filter(pk__in=op_ids, status=OperatorStatus.ACTIVE).values_list(
                    "id", flat=True
                )
            )
            missing = [i for i in op_ids if i not in found]
            if missing:
                raise CommandError(f"Unknown or inactive operators: {missing}")

        try:
            src = webhook_source_create(
                name=name,
                is_hot=bool(opts.get("hot")),
                hot_sla_minutes=sla,
                operator_ids=op_ids,
                distribution_mode=opts["distribution"],
            )
        except ApplicationError as exc:
            raise CommandError(exc.message) from exc
        self.stdout.write(self.style.SUCCESS(f"Created webhook source #{src.id} «{src.name}»"))
        self.stdout.write(webhook_path(src.webhook_token))

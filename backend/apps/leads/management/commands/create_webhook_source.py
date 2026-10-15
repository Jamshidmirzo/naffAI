"""
Create (or re-key) a webhook lead source — LeadPixel «Своя CRM» and the like.

    python manage.py create_webhook_source --name "LeadPixel (Meta)" --hot --hot-sla 10 \
        --operators 3,7 --distribution alias_or_rr
    python manage.py create_webhook_source --rotate 12        # new URL token
    python manage.py create_webhook_source --rotate-key 12    # new X-API-Key

Prints the intake path `/api/integrations/leads/<token>/` (prepend the
public host, https://naff.flek.uz) and the API key. In LeadPixel: URL →
«Адрес приёма лидов (webhook)», key → the field LeadPixel sends as
`X-API-Key`. The source then shows up in «Таблицы» like any sheet:
operator pool, hot SLA, sales attribution.
"""

from __future__ import annotations

from django.core.management.base import BaseCommand, CommandError

from apps.common.exceptions import ApplicationError
from apps.leads.integrations.webhook.services import (
    webhook_path,
    webhook_source_create,
    webhook_source_rotate_api_key,
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
        parser.add_argument("--rotate", type=int, help="Rotate the URL token of webhook source <id>.")
        parser.add_argument("--rotate-key", type=int, help="Rotate the X-API-Key of webhook source <id>.")

    def _print(self, src: SheetSource) -> None:
        self.stdout.write(f"URL: {webhook_path(src.webhook_token)}")
        self.stdout.write(f"X-API-Key: {src.webhook_api_key}")

    def _webhook_source(self, pk: int) -> SheetSource:
        src = SheetSource.objects.filter(pk=pk, kind=SheetSourceKind.WEBHOOK).first()
        if src is None:
            raise CommandError(f"No webhook source with id={pk}")
        return src

    def handle(self, *args, **opts) -> None:
        if opts.get("rotate"):
            src = webhook_source_rotate_token(source=self._webhook_source(opts["rotate"]))
            self.stdout.write(self.style.SUCCESS(f"Rotated token of source #{src.id} «{src.name}»"))
            self._print(src)
            return
        if opts.get("rotate_key"):
            src = webhook_source_rotate_api_key(source=self._webhook_source(opts["rotate_key"]))
            self.stdout.write(self.style.SUCCESS(f"Rotated API key of source #{src.id} «{src.name}»"))
            self._print(src)
            return

        name = (opts.get("name") or "").strip()
        if not name:
            raise CommandError("--name is required (or --rotate / --rotate-key <id>)")
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
        self._print(src)

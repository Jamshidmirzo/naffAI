"""
Check a webhook source's LeadPixel «Ключ для CRM» without writing anything.

    python manage.py leadpixel_check_key --source 12

POSTs `{}` to the source's outbound URL (LeadPixel `/api/crm/inbound`):
400 («id is required») = key accepted, 401 = bad key. Touches no DB rows.
"""

from __future__ import annotations

from django.core.management.base import BaseCommand, CommandError

from apps.leads.integrations.webhook.outbound import check_key, outbound_url
from apps.leads.models import SheetSource, SheetSourceKind


class Command(BaseCommand):
    help = "Test the LeadPixel CRM key of a webhook source (POST {} → 400 ok / 401 bad)."

    def add_arguments(self, parser) -> None:
        parser.add_argument("--source", type=int, required=True, help="Webhook source id.")

    def handle(self, *args, **opts) -> None:
        src = SheetSource.objects.filter(pk=opts["source"], kind=SheetSourceKind.WEBHOOK).first()
        if src is None:
            raise CommandError(f"No webhook source with id={opts['source']}")
        cfg = src.outbound_config or {}
        if not cfg.get("api_key"):
            raise CommandError("outbound_config.api_key is empty — set the LeadPixel «Ключ для CRM» first")

        res = check_key(cfg)
        where = outbound_url(cfg)
        if res.status_code == 400:
            self.stdout.write(self.style.SUCCESS(f"key OK ({where} → 400: {res.body[:200]})"))
        elif res.status_code == 401:
            raise CommandError(f"bad key ({where} → 401: {res.body[:200]})")
        elif res.status_code is None:
            raise CommandError(f"no answer from {where}: {res.body[:200]}")
        else:
            raise CommandError(f"unexpected HTTP {res.status_code} from {where}: {res.body[:200]}")

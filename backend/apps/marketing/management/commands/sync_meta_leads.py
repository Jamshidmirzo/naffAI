"""
Забрать новые заявки из лид-форм Meta для включённых страниц.

  python manage.py sync_meta_leads                 # все включённые страницы, разово
  python manage.py sync_meta_leads --page 3        # одна страница
  python manage.py sync_meta_leads --loop          # воркер `meta-leads-sync`, раз в минуту
"""

from __future__ import annotations

import logging
import time

from django.core.management.base import BaseCommand, CommandError
from django.db import connections

from apps.common.health import record_heartbeat
from apps.marketing.integrations.meta.client import MetaApiError
from apps.marketing.integrations.meta.leads import meta_leads_sync_all, meta_page_leads_sync
from apps.marketing.models import MetaPage

logger = logging.getLogger("apps.marketing.meta")


class Command(BaseCommand):
    help = "Import new leads from Meta lead forms of enabled pages."

    def add_arguments(self, parser) -> None:
        parser.add_argument("--page", type=int, help="MetaPage id")
        parser.add_argument("--loop", action="store_true", help="Run forever, every --interval")
        parser.add_argument("--interval", type=int, default=60, help="Seconds between runs")

    def handle(self, *args, **opts) -> None:
        if opts["page"]:
            page = MetaPage.objects.select_related("connection", "source").filter(pk=opts["page"]).first()
            if page is None:
                raise CommandError(f"MetaPage #{opts['page']} not found")
            try:
                self.stdout.write(str(meta_page_leads_sync(page)))
            except MetaApiError as exc:
                raise CommandError(str(exc)) from exc
            return

        if not opts["loop"]:
            for row in meta_leads_sync_all():
                self.stdout.write(str(row))
            return

        self.stdout.write("meta-leads-sync worker started")
        while True:
            try:
                meta_leads_sync_all()
                record_heartbeat("meta_leads_sync")
            except Exception:
                logger.exception("meta-leads-sync tick failed")
                connections.close_all()
            time.sleep(max(20, opts["interval"]))

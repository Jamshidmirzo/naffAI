"""
Скачать статистику Meta Ads (Marketing API) для включённых рекламных аккаунтов.

  python manage.py sync_meta_ads                 # все включённые, разово
  python manage.py sync_meta_ads --account 3     # один аккаунт (даже выключенный)
  python manage.py sync_meta_ads --days 30       # переписать последние 30 дней
  python manage.py sync_meta_ads --loop          # воркер `meta-ads-sync`, раз в час
"""

from __future__ import annotations

import logging
import time

from django.core.management.base import BaseCommand, CommandError
from django.db import connections

from apps.common.health import record_heartbeat
from apps.marketing.integrations.meta.client import MetaApiError
from apps.marketing.integrations.meta.sync import meta_account_sync, meta_sync_all
from apps.marketing.models import MetaAdAccount

logger = logging.getLogger("apps.marketing.meta")


class Command(BaseCommand):
    help = "Sync Meta Ads insights (spend, leads, video) for active ad accounts."

    def add_arguments(self, parser) -> None:
        parser.add_argument("--account", type=int, help="MetaAdAccount id")
        parser.add_argument("--days", type=int, help="How many days back to (re)load")
        parser.add_argument("--loop", action="store_true", help="Run forever, every --interval")
        parser.add_argument("--interval", type=int, default=3600, help="Seconds between runs")

    def handle(self, *args, **opts) -> None:
        if opts["account"]:
            account = MetaAdAccount.objects.select_related("connection").filter(
                pk=opts["account"]
            ).first()
            if account is None:
                raise CommandError(f"MetaAdAccount #{opts['account']} not found")
            try:
                self.stdout.write(str(meta_account_sync(account, days=opts["days"])))
            except MetaApiError as exc:
                raise CommandError(str(exc)) from exc
            return

        if not opts["loop"]:
            for row in meta_sync_all(days=opts["days"]):
                self.stdout.write(str(row))
            return

        self.stdout.write("meta-ads-sync worker started")
        while True:
            try:
                results = meta_sync_all(days=opts["days"])
                if results:
                    logger.info("meta ads sync: %s", results)
                record_heartbeat("meta_ads_sync")
            except Exception:
                logger.exception("meta-ads-sync tick failed")
                connections.close_all()
            time.sleep(max(60, opts["interval"]))

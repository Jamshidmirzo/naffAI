"""
Management command: run the TG user-client asyncio runner.

Usage:
    python manage.py run_tg_userclient

One instance per deployment. Under systemd/supervisor in production.
"""

import asyncio

from django.core.management.base import BaseCommand


class Command(BaseCommand):
    help = "Start the Telegram user-client runner (asyncio event loop)"

    def handle(self, *args, **options):
        from apps.tg_userclient.runner import run_forever

        self.stdout.write(self.style.SUCCESS("Starting TG userclient runner..."))
        try:
            asyncio.run(run_forever())
        except KeyboardInterrupt:
            self.stdout.write(self.style.WARNING("Runner stopped by keyboard interrupt"))

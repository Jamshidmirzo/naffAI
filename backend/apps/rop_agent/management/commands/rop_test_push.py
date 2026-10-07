"""
Smoke-test command: push a hello-world message (or just log it with --dry-run)
to the owner's Telegram chat to prove env + aiogram wiring works end-to-end.
"""

from __future__ import annotations

from django.conf import settings
from django.core.management.base import BaseCommand

from apps.rop_agent.telegram import send_to_owner


class Command(BaseCommand):
    help = "Send a test ROP push to the owner's Telegram chat (or dry-run)."

    def add_arguments(self, parser):
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="Log the message instead of sending to Telegram.",
        )
        parser.add_argument(
            "--text",
            default="✅ <b>ROP Agent ulandi</b>\nSmoke-test push ishga tushdi.",
        )

    def handle(self, *args, **opts):
        text = opts["text"]
        if opts["dry_run"]:
            self.stdout.write(
                self.style.WARNING(
                    f"DRY-RUN would send to chat_id={settings.ROP_OWNER_TG_CHAT_ID}:\n{text}"
                )
            )
            return
        msg_id = send_to_owner(text)
        if msg_id:
            self.stdout.write(self.style.SUCCESS(f"sent, message_id={msg_id}"))
        else:
            self.stdout.write(
                self.style.ERROR("push failed — check TELEGRAM_BOT_TOKEN and ROP_OWNER_TG_CHAT_ID")
            )

"""
Promote due callback reminders to `overdue` and (best-effort) DM their
owner on Telegram.

Cron: run every minute alongside `sync_sheets_leads`.

    * * * * * cd /opt/naffAI && ./venv/bin/python manage.py check_due_callbacks >> /var/log/naff/callbacks.log 2>&1

We DO NOT need Celery/Redis for this — a single-writer cron job scans a
few rows per tick, uses `select_for_update` on each row, and never blocks
long. If two cron ticks race, `select_for_update(skip_locked=True)`
makes the second one silently skip contested rows on this pass.
"""

from __future__ import annotations

import asyncio
import logging

from django.core.management.base import BaseCommand
from django.db import transaction

from apps.calls.models import CallbackReminder, CallbackReminderStatus
from apps.calls.selectors import callbacks_pending_due
from apps.calls.services import callback_mark_dm_sent, callback_mark_overdue, overdue_cutoff

logger = logging.getLogger("calls.check_due_callbacks")


class Command(BaseCommand):
    help = "Promote due callback reminders to `overdue` and DM operators on Telegram."

    def add_arguments(self, parser) -> None:
        parser.add_argument(
            "--no-dm",
            action="store_true",
            help="Skip Telegram DM fan-out (still promotes rows to overdue).",
        )

    def handle(self, *args, **opts) -> None:
        promoted = self._promote_overdue()
        dm_sent = 0
        if not opts.get("no_dm"):
            dm_sent = self._send_dms()
        self.stdout.write(
            self.style.SUCCESS(f"promoted={promoted} dm_sent={dm_sent}")
        )

    # --- promotion --------------------------------------------------------

    @transaction.atomic
    def _promote_overdue(self) -> int:
        cutoff = overdue_cutoff()
        rows = list(
            CallbackReminder.objects.select_for_update(skip_locked=True)
            .filter(
                status__in=(
                    CallbackReminderStatus.PENDING,
                    CallbackReminderStatus.SNOOZED,
                ),
                remind_at__lte=cutoff,
            )
            .order_by("remind_at")[:200]
        )
        for r in rows:
            callback_mark_overdue(reminder=r)
        return len(rows)

    # --- DM fan-out -------------------------------------------------------

    def _send_dms(self) -> int:
        due = list(
            callbacks_pending_due()
            .filter(dm_sent_at__isnull=True)
            .select_related("operator", "lead")[:100]
        )
        # Also DM `overdue` rows that haven't been notified yet — the promotion
        # loop above sets their status but not `dm_sent_at`.
        overdue = list(
            CallbackReminder.objects.filter(
                status=CallbackReminderStatus.OVERDUE,
                dm_sent_at__isnull=True,
            ).select_related("operator", "lead")[:100]
        )
        candidates = due + overdue
        if not candidates:
            return 0

        # Import lazily so tests / offline setups don't try to hit Telegram.
        try:
            from apps.tg_bot.notify import send_callback_dm
        except Exception:
            logger.exception("Telegram notifier unavailable — skipping DM fan-out")
            return 0

        sent = 0
        for cb in candidates:
            profile = self._profile_for_operator(cb.operator_id)
            if not profile or not profile.telegram_user_id:
                continue
            try:
                ok = asyncio.run(send_callback_dm(profile.telegram_user_id, cb))
            except Exception:
                logger.exception("DM send failed for cb#%s", cb.id)
                ok = False
            if ok:
                callback_mark_dm_sent(reminder=cb)
                sent += 1
        return sent

    def _profile_for_operator(self, operator_id: int | None):
        if not operator_id:
            return None
        from apps.users.models import Profile

        return Profile.objects.filter(operator_id=operator_id).first()

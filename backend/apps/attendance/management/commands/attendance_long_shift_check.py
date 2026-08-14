import asyncio
import logging
from django.core.management.base import BaseCommand
from django.utils import timezone
from django.db import transaction

from apps.users.models import Profile, Role
from apps.attendance.models import AttendanceLog, AttendanceSettings
from apps.attendance.services import audit_log_create
from apps.tg_bot.notify import send_long_shift_warning_dms

logger = logging.getLogger("attendance.long_shift_check")


class Command(BaseCommand):
    help = "Check for long shifts and send Telegram warning notifications"

    def add_arguments(self, parser):
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="Check long shifts without sending notifications or writing to DB",
        )

    def handle(self, *args, **options):
        dry_run = options["dry_run"]
        settings_obj = AttendanceSettings.objects.get_or_create(pk=1)[0]
        warning_hours = settings_obj.long_shift_warning_hours

        now = timezone.now()
        threshold = now - timezone.timedelta(hours=warning_hours)

        logs = AttendanceLog.objects.filter(
            checked_out_at__isnull=True,
            long_shift_warning_sent_at__isnull=True,
            warning_dismissed_at__isnull=True,
            checked_in_at__lte=threshold,
        )

        if dry_run:
            self.stdout.write(f"[Dry Run] Found {logs.count()} long shifts")
            return

        for log in logs:
            # Phase 1: Claim the log
            op_tg_id = None
            tl_tg_id = None
            log_id = log.id
            operator_name = ""

            with transaction.atomic():
                try:
                    locked_log = AttendanceLog.objects.select_for_update().get(id=log_id)
                except AttendanceLog.DoesNotExist:
                    continue

                if locked_log.long_shift_warning_sent_at or locked_log.warning_dismissed_at or locked_log.checked_out_at:
                    continue

                op_profile = Profile.objects.filter(
                    operator=locked_log.operator, telegram_user_id__isnull=False
                ).first()
                op_tg_id = op_profile.telegram_user_id if op_profile else None

                # Opt-in: only seniors who /link'ed AND stay subscribed
                # (BotSubscription.is_active) receive long-shift pings.
                from apps.tg_bot.models import BotSubscription

                _active_ids = set(
                    BotSubscription.objects.filter(is_active=True).values_list(
                        "chat_id", flat=True
                    )
                )
                tl_profiles = Profile.objects.filter(
                    role__in=[Role.TEAM_LEAD, Role.MANAGER, Role.SUPERADMIN],
                    telegram_user_id__isnull=False,
                    telegram_user_id__in=_active_ids,
                )
                tl_tg_ids = [p.telegram_user_id for p in tl_profiles]

                if not op_tg_id and not tl_tg_ids:
                    audit_log_create(
                        user=None,
                        action="attendance.warning_skipped_no_recipients",
                        entity="AttendanceLog",
                        entity_id=locked_log.id,
                        changes={
                            "log_id": locked_log.id,
                            "operator_id": locked_log.operator_id,
                            "reason": "no_tg_operator_and_no_team_lead",
                        },
                    )
                    self.stdout.write(f"Skipped log {locked_log.id}: no recipients")
                    continue

                tl_tg_id = tl_tg_ids[0] if tl_tg_ids else None
                operator_name = locked_log.operator.full_name

                locked_log.long_shift_warning_sent_at = timezone.now()
                locked_log.save(update_fields=["long_shift_warning_sent_at"])

            # Phase 2: Send DMs (outside transaction)
            sent_to = []
            try:
                sent_to = asyncio.run(
                    send_long_shift_warning_dms(
                        operator_tg_id=op_tg_id,
                        tl_tg_id=tl_tg_id,
                        log_id=log_id,
                        operator_name=operator_name,
                        hours=warning_hours,
                    )
                )
            except Exception as e:
                logger.error(f"Error sending warning DMs for log {log_id}: {e}")

            # Phase 3: Rollback or audit log
            if not sent_to:
                with transaction.atomic():
                    try:
                        rollback_log = AttendanceLog.objects.select_for_update().get(id=log_id)
                        rollback_log.long_shift_warning_sent_at = None
                        rollback_log.save(update_fields=["long_shift_warning_sent_at"])
                    except AttendanceLog.DoesNotExist:
                        pass
            else:
                audit_log_create(
                    user=None,
                    action="attendance.long_shift_warning_sent",
                    entity="AttendanceLog",
                    entity_id=log_id,
                    changes={
                        "log_id": log_id,
                        "hours": warning_hours,
                        "sent_to": sent_to,
                    },
                )
                self.stdout.write(f"Notified long shift log {log_id}: {sent_to}")

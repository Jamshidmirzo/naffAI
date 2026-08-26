"""
Cron: `attendance_checkout_reminder` (enforcement wave 2026-08-26).

Раз в 15 минут пробегается по open AttendanceLog и, если
`checked_in_at + AttendanceSettings.checkout_reminder_after_hours` уже
прошло, а `checkout_reminder_sent_at` ещё пустой:

  1. Шлёт оператору TG DM «прошло 8 часов, не забудьте отметиться об
     уходе» с inline-кнопкой [🚪 Отметить уход] → callback
     `attendance:auto_checkout_confirm:<log_id>` (уже обрабатывается в
     `runner.py:1191`).
  2. Создаёт in-app Notification с
     `metadata.kind = "attendance_checkout_reminder"` — фронт
     показывает оранжевый баннер (dismiss в localStorage).
  3. Ставит `AttendanceLog.checkout_reminder_sent_at = now()` — спам-guard,
     повторный запуск команды не отправит второй раз.

Не отправляет:
  - логам, у которых `checkout_reminder_after_hours == 0` (feature off);
  - оператору без TG (в этом случае Notification всё равно создаётся —
    оператор увидит баннер, зайдя в CRM);
  - если TG-send упал целиком → откатываем `checkout_reminder_sent_at`
    (аналогично long_shift_check, следующий cron попробует снова).

Не спамит менеджеров: это операторская нотификация, senior'ов не
касается. Long-shift-check + attendance-widget уже даёт менеджеру
видимость «кто до сих пор не вышел».
"""

from __future__ import annotations

import asyncio
import logging

from django.conf import settings
from django.core.management.base import BaseCommand
from django.db import transaction
from django.utils import timezone

from apps.attendance.models import AttendanceLog, AttendanceSettings
from apps.audit.services import audit_log_create
from apps.notifications.models import Notification, NotificationKind
from apps.users.models import Profile

logger = logging.getLogger("attendance.checkout_reminder")


class Command(BaseCommand):
    help = (
        "Send soft «не забудьте отметиться об уходе» reminder to operators "
        "whose open shift is older than AttendanceSettings.checkout_reminder_after_hours"
    )

    def add_arguments(self, parser):
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="Show what would be sent without touching DB or Telegram",
        )

    def handle(self, *args, **options):
        dry_run: bool = options["dry_run"]
        settings_obj = AttendanceSettings.objects.get_or_create(pk=1)[0]
        after_hours = int(settings_obj.checkout_reminder_after_hours or 0)
        if after_hours <= 0:
            self.stdout.write("checkout_reminder disabled (after_hours=0)")
            return

        now = timezone.now()
        threshold = now - timezone.timedelta(hours=after_hours)

        # Реминдер шлём ТОЛЬКО тем операторам, у кого включён
        # `require_checkin_enabled` — это тот же per-operator opt-in,
        # что и для UI-гейта. Иначе rollout ломается: prod-операторы
        # (все с флагом False) начали бы получать новый DM про уход
        # без предупреждения. Long-shift-warning с порогом 10ч у них
        # уже есть — этого достаточно.
        logs = AttendanceLog.objects.filter(
            checked_out_at__isnull=True,
            checkout_reminder_sent_at__isnull=True,
            checked_in_at__lte=threshold,
            operator__require_checkin_enabled=True,
        ).select_related("operator")

        if dry_run:
            self.stdout.write(
                f"[Dry Run] Found {logs.count()} shifts eligible for reminder"
            )
            for log in logs:
                self.stdout.write(
                    f"  log#{log.id} op={log.operator.full_name} "
                    f"checked_in_at={log.checked_in_at.isoformat()}"
                )
            return

        for log in logs:
            self._process_one(log, after_hours=after_hours)

    def _process_one(self, log: AttendanceLog, *, after_hours: int) -> None:
        """
        Two-phase send: (1) claim the log by writing
        `checkout_reminder_sent_at`; (2) fire TG DM + Notification; (3)
        if step 2 failed completely, rollback the timestamp so the next
        cron retry sees the log again. Same pattern as
        `attendance_long_shift_check`.
        """
        log_id = log.id
        with transaction.atomic():
            try:
                locked = AttendanceLog.objects.select_for_update().get(id=log_id)
            except AttendanceLog.DoesNotExist:
                return
            if (
                locked.checkout_reminder_sent_at is not None
                or locked.checked_out_at is not None
            ):
                return
            locked.checkout_reminder_sent_at = timezone.now()
            locked.save(update_fields=["checkout_reminder_sent_at"])
            operator = locked.operator

        # 2. Notification (always attempted, doesn't need TG)
        try:
            profile = (
                Profile.objects.select_related("user")
                .filter(operator_id=operator.id, user__is_active=True)
                .first()
            )
            recipient = profile.user if profile else None
            notification_created = False
            if recipient is not None:
                Notification.objects.create(
                    recipient=recipient,
                    kind=NotificationKind.SYSTEM,
                    title="Не забудьте отметиться об уходе",
                    body=f"Прошло {after_hours} часов — время закрыть смену",
                    link="/my",
                    metadata={
                        "kind": "attendance_checkout_reminder",
                        "log_id": log_id,
                        "operator_id": operator.id,
                        "hours_since_checkin": after_hours,
                    },
                )
                notification_created = True
        except Exception:
            logger.exception(
                "checkout_reminder Notification create failed log=%s", log_id
            )
            notification_created = False

        # 3. TG DM (opt-in — только если оператор /link'нул TG)
        tg_ok = False
        op_tg_id = None
        try:
            op_profile = Profile.objects.filter(
                operator_id=operator.id, telegram_user_id__isnull=False
            ).first()
            op_tg_id = op_profile.telegram_user_id if op_profile else None
            if op_tg_id and getattr(settings, "TELEGRAM_BOT_TOKEN", ""):
                tg_ok = asyncio.run(
                    _send_checkout_reminder_dm(
                        operator_tg_id=op_tg_id,
                        log_id=log_id,
                        operator_name=operator.full_name,
                        hours=after_hours,
                    )
                )
        except Exception:
            logger.exception(
                "checkout_reminder TG DM failed log=%s op_tg=%s", log_id, op_tg_id
            )
            tg_ok = False

        # 4. Rollback timestamp if BOTH channels failed — retry next tick.
        if not notification_created and not tg_ok:
            with transaction.atomic():
                try:
                    rb = AttendanceLog.objects.select_for_update().get(id=log_id)
                    rb.checkout_reminder_sent_at = None
                    rb.save(update_fields=["checkout_reminder_sent_at"])
                except AttendanceLog.DoesNotExist:
                    pass
            logger.warning(
                "checkout_reminder rolled back log=%s: no channels succeeded",
                log_id,
            )
            self.stdout.write(f"log#{log_id} — rolled back (no delivery channel)")
            return

        audit_log_create(
            user=None,
            action="attendance.checkout_reminder_sent",
            entity="AttendanceLog",
            entity_id=log_id,
            changes={
                "log_id": log_id,
                "operator_id": operator.id,
                "hours": after_hours,
                "notification_created": notification_created,
                "tg_sent": tg_ok,
            },
        )
        self.stdout.write(
            f"log#{log_id} reminder — notification={notification_created} tg={tg_ok}"
        )


async def _send_checkout_reminder_dm(
    *,
    operator_tg_id: int,
    log_id: int,
    operator_name: str,
    hours: int,
) -> bool:
    """
    Тонкий DM: оранжевое напоминание + одна inline-кнопка
    [🚪 Отметить уход] с callback `attendance:auto_checkout_confirm:<log_id>`.

    Callback уже обработан в `runner.py:1191` — жмёшь → бот вызывает
    `process_attendance_event` → смена закрывается. Без FSM/фото —
    именно как soft reminder, не гейт.

    Возвращает True iff Telegram принял сообщение.
    """
    try:
        from aiogram import Bot
        from aiogram.exceptions import TelegramForbiddenError
        from aiogram.types import InlineKeyboardButton, InlineKeyboardMarkup
    except ImportError:
        logger.warning("aiogram missing — DM skipped")
        return False

    token = getattr(settings, "TELEGRAM_BOT_TOKEN", "")
    if not token:
        return False

    bot = Bot(token=token)
    try:
        text = (
            f"⏱ <b>{operator_name}</b>, прошло {hours} часов работы.\n"
            f"Не забудьте отметиться об уходе — иначе смена закроется автоматически в 23:00."
        )
        kb = InlineKeyboardMarkup(
            inline_keyboard=[
                [
                    InlineKeyboardButton(
                        text="🚪 Отметить уход",
                        callback_data=f"attendance:auto_checkout_confirm:{log_id}",
                    ),
                ]
            ]
        )
        try:
            await bot.send_message(
                operator_tg_id, text, parse_mode="HTML", reply_markup=kb
            )
            return True
        except TelegramForbiddenError:
            logger.info(
                "checkout_reminder skipped: op tg=%s blocked bot", operator_tg_id
            )
            return False
        except Exception:
            logger.exception(
                "checkout_reminder send failed op tg=%s", operator_tg_id
            )
            return False
    finally:
        try:
            await bot.session.close()
        except Exception:
            pass

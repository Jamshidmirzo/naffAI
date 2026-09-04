"""
Cron: `attendance_nine_hour_notification` (2026-09-03).

Каждые 15 минут пробегается по открытым AttendanceLog'ам:
  - `checked_out_at IS NULL`,
  - `nine_hour_notified_at IS NULL` (idempotency),
  - `checked_in_at + AttendanceSettings.nine_hour_reminder_hours` уже прошло,
  - **и** не позже `shift_end + N часов` (иначе разбудим оператора ночью;
    план: если ушёл, но забыл нажать /checkout — уже есть отдельный
    reminder + 23:00 auto-close).

→ создаёт in-app Notification оператору
     `metadata.kind = "attendance_shift_9h"`, ставит
     `AttendanceLog.nine_hour_notified_at = now()`.

Отличается от `attendance_checkout_reminder`:
  - тот шлёт в 8ч (soft «не забудьте отметиться») с TG-DM;
  - этот — в 9ч (жёстче: «пора закрыть смену») **только in-app**, без DM;
  - оба идемпотентны через свои `*_sent_at` таймстампы.

Мягкое правило: если `checkout_reminder_after_hours=0` (выключен), то и
9h reminder тоже выключен — менеджер явно решил не спамить.
"""

from __future__ import annotations

import datetime as dt
import logging

from django.core.management.base import BaseCommand
from django.db import transaction
from django.utils import timezone

from apps.attendance.models import AttendanceLog, AttendanceSettings
from apps.attendance.services import audit_log_create, resolve_operator_config
from apps.notifications.models import Notification, NotificationKind
from apps.users.models import Profile

logger = logging.getLogger("attendance.nine_hour_notification")


class Command(BaseCommand):
    help = "Send «пора закрыть смену» in-app notification after N hours from check-in."

    def add_arguments(self, parser):
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="Show what would be sent without touching DB.",
        )

    def handle(self, *args, **options):
        dry_run: bool = options["dry_run"]
        settings_obj = AttendanceSettings.objects.get_or_create(pk=1)[0]
        n_hours = int(getattr(settings_obj, "nine_hour_reminder_hours", 9) or 0)
        if n_hours <= 0:
            self.stdout.write("nine_hour_reminder disabled (hours=0)")
            return
        global_enforce = bool(getattr(settings_obj, "enforce_daily_checkin", False))

        now = timezone.now()
        threshold = now - dt.timedelta(hours=n_hours)
        # Нижняя граница — начало вчерашнего дня по локали. Иначе на
        # первом запуске уведомим всех, кто забыл /checkout за N недель
        # (например Dostonbek с 16 августа). Сегодняшняя+вчерашняя
        # незакрытая смена — достаточно для рабочего кейса.
        tz = timezone.get_current_timezone()
        yesterday_local = timezone.localdate() - dt.timedelta(days=1)
        yesterday_start = dt.datetime.combine(
            yesterday_local, dt.time.min, tzinfo=tz
        )

        qs = AttendanceLog.objects.filter(
            checked_out_at__isnull=True,
            nine_hour_notified_at__isnull=True,
            checked_in_at__gte=yesterday_start,
            checked_in_at__lte=threshold,
        ).select_related("operator")

        if not global_enforce:
            qs = qs.filter(operator__require_checkin_enabled=True)

        # Ночью не будим — если shift_end уже прошёл и мы «прыгаем» за
        # 3ч+ окно после конца смены, вероятно оператор забыл /checkout;
        # это обработает `attendance_auto_close` в 23:00, не наш кейс.
        # Проверяем в _process_one (нужно local time).

        if dry_run:
            self.stdout.write(f"[Dry Run] Found {qs.count()} open logs past {n_hours}h")
            for log in qs:
                self.stdout.write(
                    f"  log#{log.id} op={log.operator.full_name} "
                    f"in={log.checked_in_at.isoformat()}"
                )
            return

        for log in qs:
            # `shift_end` — уважаем per-operator override, чтобы
            # оператор с вечерней сменой (22:00) не отсеивался «past
            # shift_end+3h» проверкой по глобальному 20:00.
            cfg = resolve_operator_config(log.operator)
            self._process_one(log, n_hours=n_hours, shift_end=cfg["shift_end"])

    def _process_one(
        self, log: AttendanceLog, *, n_hours: int, shift_end
    ) -> None:
        log_id = log.id
        # Не будим ночью: если сейчас > shift_end + 3ч, считаем, что
        # оператор уже ушёл, но забыл. auto_close_open_logs подхватит.
        now_local = timezone.localtime(timezone.now())
        try:
            if hasattr(shift_end, "hour"):
                end_h, end_m = shift_end.hour, shift_end.minute
            else:
                parts = str(shift_end).split(":")
                end_h, end_m = int(parts[0]), int(parts[1]) if len(parts) > 1 else 0
            end_dt = now_local.replace(hour=end_h, minute=end_m, second=0, microsecond=0)
        except Exception:
            end_dt = now_local.replace(hour=20, minute=0, second=0, microsecond=0)

        if now_local > end_dt + dt.timedelta(hours=3):
            self.stdout.write(f"log#{log_id} skipped — past shift_end+3h")
            return

        with transaction.atomic():
            try:
                locked = AttendanceLog.objects.select_for_update().get(id=log_id)
            except AttendanceLog.DoesNotExist:
                return
            if (
                locked.nine_hour_notified_at is not None
                or locked.checked_out_at is not None
            ):
                return
            locked.nine_hour_notified_at = timezone.now()
            locked.save(update_fields=["nine_hour_notified_at"])
            operator = locked.operator
            checked_in_at = locked.checked_in_at

        # In-app Notification
        try:
            profile = (
                Profile.objects.select_related("user")
                .filter(operator_id=operator.id, user__is_active=True)
                .first()
            )
            recipient = profile.user if profile else None
            if recipient is None:
                return  # некому слать — timestamp остаётся выставленным

            worked_h = round(
                (timezone.now() - checked_in_at).total_seconds() / 3600, 1
            )
            Notification.objects.create(
                recipient=recipient,
                kind=NotificationKind.SYSTEM,
                title="Пора закрыть смену",
                body=(
                    f"Вы работаете уже {worked_h} часов. "
                    f"Не забудьте нажать «Завершить смену»."
                ),
                link="/my",
                metadata={
                    "kind": "attendance_shift_9h",
                    "log_id": log_id,
                    "operator_id": operator.id,
                    "hours_since_checkin": n_hours,
                },
            )
        except Exception:
            logger.exception("nine_hour create failed log=%s", log_id)
            with transaction.atomic():
                try:
                    rb = AttendanceLog.objects.select_for_update().get(id=log_id)
                    rb.nine_hour_notified_at = None
                    rb.save(update_fields=["nine_hour_notified_at"])
                except AttendanceLog.DoesNotExist:
                    pass
            return

        audit_log_create(
            user=None,
            action="attendance.nine_hour_notified",
            entity="AttendanceLog",
            entity_id=log_id,
            changes={
                "log_id": log_id,
                "operator_id": operator.id,
                "hours": n_hours,
            },
        )
        self.stdout.write(f"log#{log_id} 9h reminder sent op={operator.full_name}")

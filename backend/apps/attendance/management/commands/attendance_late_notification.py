"""
Cron: `attendance_late_notification` (daily-checkin enforcement 2026-09-03).

Раз в 5 минут пробегается по сегодняшним AttendanceLog'ам и:

  1. Если `checked_in_at > shift_start + late_threshold_min` (проверка
     проходит на самой смене — `AttendanceLog.was_late=True`);
  2. `late_notified_at IS NULL` — уведомление за смену ещё не слали;

  → создаёт in-app Notification оператору
     `metadata.kind = "attendance_late"`, ставит
     `AttendanceLog.late_notified_at=now()`.

Идемпотентно: один раз за смену. Если оператор опоздал утром и ушёл в
обед — второе уведомление уже не придёт.

Не спамит менеджеров: opozdanie видно им и так через attendance-report /
daily digest. Это персональное «намекающее» уведомление оператору.
"""

from __future__ import annotations

import logging

from django.core.management.base import BaseCommand
from django.db import transaction
from django.utils import timezone

from apps.attendance.models import AttendanceLog, AttendanceSettings
from apps.attendance.services import audit_log_create, resolve_operator_config
from apps.notifications.models import Notification, NotificationKind
from apps.users.models import Profile

logger = logging.getLogger("attendance.late_notification")


class Command(BaseCommand):
    help = (
        "Send «you're late today» in-app notification to operators whose "
        "current shift is flagged was_late=True and hasn't been notified yet."
    )

    def add_arguments(self, parser):
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="Show what would be sent without touching DB.",
        )

    def handle(self, *args, **options):
        dry_run: bool = options["dry_run"]
        settings_obj = AttendanceSettings.objects.get_or_create(pk=1)[0]
        # Только для команд с включённым обязательным check-in'ом (глобально
        # или per-op). Если менеджер выключил гейт — уведомлений тоже не шлём:
        # нет смысла ругать за опоздание, если правило само по себе off.
        global_enforce = bool(getattr(settings_obj, "enforce_daily_checkin", False))

        # Сегодняшние open или recent logs (лимитим 24ч, чтобы не гонять
        # весь исторический список — реально late-уведомление всегда про
        # текущую смену).
        since = timezone.now() - timezone.timedelta(hours=24)
        qs = AttendanceLog.objects.filter(
            was_late=True,
            late_notified_at__isnull=True,
            checked_in_at__gte=since,
        ).select_related("operator")

        # Если глобальный enforce off — уведомляем только тех, у кого
        # per-op флаг включён (тонкая обкатка).
        if not global_enforce:
            qs = qs.filter(operator__require_checkin_enabled=True)

        if dry_run:
            self.stdout.write(f"[Dry Run] Found {qs.count()} logs to notify")
            for log in qs:
                self.stdout.write(
                    f"  log#{log.id} op={log.operator.full_name} "
                    f"in={log.checked_in_at.isoformat()}"
                )
            return

        # `shift_start` — уважаем per-operator override (например,
        # вечерняя смена 14:00-22:00). `late_threshold_min` живёт
        # глобально в AttendanceSettings.
        for log in qs:
            cfg = resolve_operator_config(log.operator)
            self._process_one(
                log,
                shift_start=cfg["shift_start"],
                late_threshold_min=int(settings_obj.late_threshold_min or 0),
            )

    def _process_one(self, log: AttendanceLog, *, shift_start, late_threshold_min: int) -> None:
        """Two-phase: claim (write timestamp) → deliver → rollback if failed."""
        log_id = log.id
        with transaction.atomic():
            try:
                locked = AttendanceLog.objects.select_for_update().get(id=log_id)
            except AttendanceLog.DoesNotExist:
                return
            if locked.late_notified_at is not None:
                return
            locked.late_notified_at = timezone.now()
            locked.save(update_fields=["late_notified_at"])
            operator = locked.operator
            checked_in_at = locked.checked_in_at

        # Считаем минуты опоздания (для body — понятно оператору).
        # `shift_start` может быть `time` или строкой — приводим к минутам-от-полуночи.
        try:
            if hasattr(shift_start, "hour"):
                start_min = shift_start.hour * 60 + shift_start.minute
            else:
                h, m = str(shift_start).split(":")[:2]
                start_min = int(h) * 60 + int(m)
        except Exception:
            start_min = 10 * 60  # 10:00 fallback

        local_in = timezone.localtime(checked_in_at)
        actual_min = local_in.hour * 60 + local_in.minute
        # Опоздание = сколько мы отстали от «starts + threshold». Значение
        # ниже нуля не встретится (был бы was_late=False), но обрезаем на
        # всякий случай.
        late_minutes = max(0, actual_min - start_min - late_threshold_min)

        # Создаём notification.
        try:
            profile = (
                Profile.objects.select_related("user")
                .filter(operator_id=operator.id, user__is_active=True)
                .first()
            )
            recipient = profile.user if profile else None
            if recipient is None:
                # У оператора нет user-профиля — уведомить некого. Оставляем
                # timestamp выставленным, чтобы не отправлять по кругу;
                # менеджер увидит опоздание через attendance-report.
                logger.info(
                    "late_notif skipped log=%s op=%s: no active user",
                    log_id,
                    operator.id,
                )
                return

            body_min = f"{late_minutes} мин" if late_minutes else "несколько минут"
            Notification.objects.create(
                recipient=recipient,
                kind=NotificationKind.SYSTEM,
                title="Вы опоздали сегодня",
                body=(
                    f"Приход в {local_in.strftime('%H:%M')} — опоздание {body_min}. "
                    f"Это может повлиять на дневную статистику."
                ),
                link="/my",
                metadata={
                    "kind": "attendance_late",
                    "log_id": log_id,
                    "operator_id": operator.id,
                    "minutes_late": late_minutes,
                },
            )
        except Exception:
            logger.exception("late_notif create failed log=%s", log_id)
            # Rollback timestamp — попробуем на следующем тике.
            with transaction.atomic():
                try:
                    rb = AttendanceLog.objects.select_for_update().get(id=log_id)
                    rb.late_notified_at = None
                    rb.save(update_fields=["late_notified_at"])
                except AttendanceLog.DoesNotExist:
                    pass
            return

        audit_log_create(
            user=None,
            action="attendance.late_notified",
            entity="AttendanceLog",
            entity_id=log_id,
            changes={
                "log_id": log_id,
                "operator_id": operator.id,
                "minutes_late": late_minutes,
            },
        )
        self.stdout.write(f"log#{log_id} late notif sent op={operator.full_name}")

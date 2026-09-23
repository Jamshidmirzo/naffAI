"""
Ежесуточный cron (00:05 Asia/Tashkent). Для каждого одобренного
OperatorDayOff.date == today ставит оператору is_paused=True, чтобы
он не получал новых лидов в свой выходной. Пауза снимется на
следующий check-in автоматически (см. _attendance_check_in).

Идемпотентно: если оператор уже paused — no-op. Безопасно запустить
несколько раз в сутки без побочных эффектов.
"""

from django.core.management.base import BaseCommand

from apps.operators.services import day_offs_apply_for_today


class Command(BaseCommand):
    help = "Apply approved day-off requests for today (set is_paused=True)."

    def add_arguments(self, parser):
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="Show how many operators would be paused, without changing anything.",
        )

    def handle(self, *args, **opts):
        from django.utils import timezone
        from apps.operators.models import DayOffStatus, OperatorDayOff

        today = timezone.localdate()
        reqs = OperatorDayOff.objects.filter(
            date=today, status=DayOffStatus.APPROVED
        ).select_related("operator")

        if opts["dry_run"]:
            self.stdout.write(f"[dry-run] Would pause {reqs.count()} operators for day-off on {today.isoformat()}")
            for r in reqs:
                op = r.operator
                marker = "(already paused)" if op and op.is_paused else "(will pause)"
                self.stdout.write(f"  op#{r.operator_id} {op.full_name if op else '?'} — {marker}")
            return

        paused = day_offs_apply_for_today()
        self.stdout.write(self.style.SUCCESS(
            f"attendance_apply_day_offs: paused {paused} operators for day-off on {today.isoformat()}"
        ))

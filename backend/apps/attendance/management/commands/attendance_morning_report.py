import asyncio
import datetime as dt
from django.core.management.base import BaseCommand
from django.utils import timezone
from django.conf import settings

from apps.users.models import Profile, Role
from apps.attendance.selectors import attendance_report


class Command(BaseCommand):
    help = "Send morning attendance report to Team Leads via Telegram"

    def add_arguments(self, parser):
        parser.add_argument(
            "--date",
            type=str,
            default=None,
            help="Report date (YYYY-MM-DD), default is today",
        )

    def handle(self, *args, **options):
        date_str = options["date"]
        if date_str:
            day = dt.datetime.strptime(date_str, "%Y-%m-%d").date()
        else:
            day = timezone.localdate()

        report = attendance_report(day)

        present_count = report["counts"]["present"]
        late_count = report["counts"]["late"]
        absent_count = report["counts"]["absent"]
        total = report["total_active_operators"]

        late_names = ", ".join([x["operator_name"] for x in report["late"]]) or "нет"
        absent_names = ", ".join([x["full_name"] for x in report["absent"]]) or "нет"

        text = (
            f"📊 <b>Отчёт по посещаемости за {day.strftime('%d.%m.%Y')}</b>\n\n"
            f"👤 Всего активных операторов: {total}\n"
            f"✅ Присутствуют: {present_count} / {total}\n"
            f"⏰ Опоздали: {late_count} ({late_names})\n"
            f"❌ Не пришли: {absent_count} ({absent_names})\n"
        )

        seniors = Profile.objects.filter(
            role__in=[Role.TEAM_LEAD, Role.MANAGER],
            telegram_user_id__isnull=False,
        )
        chat_ids = [s.telegram_user_id for s in seniors]

        if not chat_ids:
            self.stdout.write("No senior users with telegram_user_id configured.")
            return

        asyncio.run(self.send_report(chat_ids, text))

    async def send_report(self, chat_ids: list[int], text: str):
        try:
            from aiogram import Bot
        except ImportError:
            self.stdout.write(self.style.ERROR("aiogram is not installed"))
            return

        token = getattr(settings, "TELEGRAM_BOT_TOKEN", "")
        if not token:
            self.stdout.write(self.style.ERROR("TELEGRAM_BOT_TOKEN is not configured"))
            return

        bot = Bot(token=token)
        for chat_id in chat_ids:
            try:
                await bot.send_message(chat_id, text, parse_mode="HTML")
                self.stdout.write(
                    self.style.SUCCESS(f"Sent morning report to TL (chat_id: {chat_id})")
                )
            except Exception as exc:
                self.stdout.write(
                    self.style.ERROR(f"Failed to send morning report to {chat_id}: {exc}")
                )
        await bot.session.close()

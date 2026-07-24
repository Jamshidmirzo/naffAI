import asyncio
import calendar
import datetime as dt
import logging

from django.conf import settings
from django.core.management.base import BaseCommand
from django.utils import timezone

from apps.lessons.models import DailyLesson, DailyLessonAttempt
from apps.operators.models import Operator, OperatorStatus
from apps.users.models import Profile

logger = logging.getLogger("apps.lessons.deliver")

# Transient failures we retry, and hard failures we log-and-skip.
# Imported lazily inside `deliver_lessons` so unit tests that don't have
# aiogram installed still boot the command class.
MAX_ATTEMPTS = 3
BACKOFF_BASE_SECONDS = 1  # 1s, 2s, 4s

# Async sleep is looked up via the module (`asyncio.sleep`) so tests can
# monkeypatch it to a no-op and avoid waiting the full 7 seconds.


class Command(BaseCommand):
    help = "Deliver daily lessons to operators via Telegram DM"

    def add_arguments(self, parser):
        parser.add_argument(
            "--date",
            type=str,
            default=None,
            help="Date of the lesson (YYYY-MM-DD), default is yesterday",
        )
        parser.add_argument(
            "--operator",
            type=int,
            default=None,
            help="Filter by specific operator ID",
        )

    def handle(self, *args, **options):
        date_str = options["date"]
        if date_str:
            target_date = dt.datetime.strptime(date_str, "%Y-%m-%d").date()
        else:
            target_date = timezone.localdate() - dt.timedelta(days=1)

        operators = Operator.objects.exclude(status=OperatorStatus.INACTIVE)
        if options["operator"]:
            operators = operators.filter(id=options["operator"])
        operators = operators.exclude(daily_lesson_opt_out=True)

        payloads = []
        for op in operators:
            profile = Profile.objects.filter(operator=op, telegram_user_id__isnull=False).first()
            if not profile:
                self.stdout.write(f"Operator {op.full_name} (ID: {op.id}) has no linked telegram_user_id")
                continue

            chat_id = profile.telegram_user_id

            lesson = DailyLesson.objects.filter(
                operator=op, lesson_date=target_date, delivered_at__isnull=True
            ).first()
            if lesson:
                snapshot = lesson.stats_snapshot or {}
                sales_count = int(snapshot.get("sales_count", 0))
                revenue = float(snapshot.get("revenue_uzs", 0))
                avg_check = float(snapshot.get("avg_check", 0))
                dialogs_count = int(snapshot.get("dialogs_count", 0))
                avg_quality = float(snapshot.get("avg_quality", 0))

                last_day = calendar.monthrange(target_date.year, target_date.month)[1]
                days_to_threshold = last_day - target_date.day

                text = (
                    f"Доброе утро, {op.full_name}!\n\n"
                    f"Твой вчерашний день:\n"
                    f"Продаж: {sales_count} на {revenue:,.0f} UZS (средний чек {avg_check:,.0f})\n"
                    f"Диалогов: {dialogs_count}, качество {avg_quality:.0f}/100\n"
                    f"До плана: осталось {days_to_threshold} дней\n\n"
                    f"Сегодняшний фокус:\n"
                    f"{lesson.micro_lesson}"
                ).replace(",", " ")

                payloads.append({
                    "chat_id": chat_id,
                    "text": text,
                    "type": "lesson",
                    "id": lesson.id,
                    "op_name": op.full_name,
                })
            else:
                attempt = DailyLessonAttempt.objects.filter(
                    operator=op,
                    lesson_date=target_date,
                    status="skip",
                    delivered_at__isnull=True,
                ).first()
                if attempt:
                    last_day = calendar.monthrange(target_date.year, target_date.month)[1]
                    days_to_threshold = last_day - target_date.day
                    text = f"Вчера был день без активности — сегодня хороший шанс наверстать. До плана {days_to_threshold} дней."

                    payloads.append({
                        "chat_id": chat_id,
                        "text": text,
                        "type": "skip",
                        "id": attempt.id,
                        "op_name": op.full_name,
                    })

        if not payloads:
            self.stdout.write("No new lessons or greetings to deliver.")
            return

        success_lesson_ids, success_skip_ids = asyncio.run(self.deliver_lessons(payloads))

        # Perform DB updates synchronously in main thread
        if success_lesson_ids:
            DailyLesson.objects.filter(id__in=success_lesson_ids).update(delivered_at=timezone.now())
        if success_skip_ids:
            DailyLessonAttempt.objects.filter(id__in=success_skip_ids).update(
                delivered_at=timezone.now()
            )

    async def deliver_lessons(self, payloads: list[dict]) -> tuple[list[int], list[int]]:
        try:
            from aiogram import Bot
            from aiogram.exceptions import (
                TelegramBadRequest,
                TelegramForbiddenError,
                TelegramNetworkError,
                TelegramRetryAfter,
                TelegramServerError,
            )
            from aiogram.types import InlineKeyboardButton, InlineKeyboardMarkup
        except ImportError:
            self.stdout.write(self.style.ERROR("aiogram is not installed"))
            return [], []

        token = getattr(settings, "TELEGRAM_BOT_TOKEN", "")
        if not token:
            self.stdout.write(self.style.ERROR("TELEGRAM_BOT_TOKEN is not configured"))
            return [], []

        bot = Bot(token=token)
        frontend_url = getattr(settings, "FRONTEND_URL", "https://naffcrm.vercel.app").rstrip("/")

        success_lesson_ids: list[int] = []
        success_skip_ids: list[int] = []

        transient_excs: tuple[type[Exception], ...] = (
            TelegramNetworkError,
            TelegramServerError,
        )
        hard_excs: tuple[type[Exception], ...] = (
            TelegramForbiddenError,
            TelegramBadRequest,
        )

        for p in payloads:
            chat_id = p["chat_id"]
            text = p["text"]
            op_name = p["op_name"]

            kb = InlineKeyboardMarkup(
                inline_keyboard=[[
                    InlineKeyboardButton(
                        text="Отметить приход",
                        callback_data="attendance:checkin",
                    )
                ]]
            )
            if p["type"] == "lesson":
                kb.inline_keyboard.append([
                    InlineKeyboardButton(
                        text="Открыть полный разбор",
                        url=f"{frontend_url}/lessons/today",
                    )
                ])

            delivered = False
            for attempt_no in range(1, MAX_ATTEMPTS + 1):
                try:
                    await bot.send_message(chat_id, text, parse_mode="HTML", reply_markup=kb)
                    delivered = True
                    logger.info(
                        "delivered %s to %s on attempt %d/%d",
                        p["type"], op_name, attempt_no, MAX_ATTEMPTS,
                    )
                    self.stdout.write(self.style.SUCCESS(
                        f"Delivered {p['type']} to {op_name} (attempt {attempt_no}/{MAX_ATTEMPTS})"
                    ))
                    break
                except TelegramRetryAfter as exc:
                    # Server told us to wait exactly N seconds — honour it,
                    # but still count this as one of our attempts.
                    wait_s = getattr(exc, "retry_after", BACKOFF_BASE_SECONDS)
                    logger.warning(
                        "TG asked to retry_after=%ss for %s (attempt %d/%d)",
                        wait_s, op_name, attempt_no, MAX_ATTEMPTS,
                    )
                    self.stdout.write(self.style.WARNING(
                        f"TG retry_after={wait_s}s for {op_name} "
                        f"(attempt {attempt_no}/{MAX_ATTEMPTS})"
                    ))
                    if attempt_no == MAX_ATTEMPTS:
                        break
                    await asyncio.sleep(wait_s)
                except transient_excs as exc:
                    logger.warning(
                        "transient TG error for %s on attempt %d/%d: %s",
                        op_name, attempt_no, MAX_ATTEMPTS, exc,
                    )
                    self.stdout.write(self.style.WARNING(
                        f"Transient TG error for {op_name} "
                        f"(attempt {attempt_no}/{MAX_ATTEMPTS}): {exc}"
                    ))
                    if attempt_no == MAX_ATTEMPTS:
                        break
                    await asyncio.sleep(BACKOFF_BASE_SECONDS * (2 ** (attempt_no - 1)))
                except hard_excs as exc:
                    # Bot blocked, chat not found, malformed message — no
                    # point retrying. Log and move on to the next operator.
                    logger.error(
                        "hard TG error for %s (%s), not retrying: %s",
                        op_name, type(exc).__name__, exc,
                    )
                    self.stdout.write(self.style.ERROR(
                        f"Hard TG error for {op_name} ({type(exc).__name__}), skipping: {exc}"
                    ))
                    break
                except Exception as exc:
                    logger.exception(
                        "unexpected error sending to %s (attempt %d/%d)",
                        op_name, attempt_no, MAX_ATTEMPTS,
                    )
                    self.stdout.write(self.style.ERROR(
                        f"Unexpected error for {op_name} "
                        f"(attempt {attempt_no}/{MAX_ATTEMPTS}): {exc}"
                    ))
                    if attempt_no == MAX_ATTEMPTS:
                        break
                    await asyncio.sleep(BACKOFF_BASE_SECONDS * (2 ** (attempt_no - 1)))

            if delivered:
                if p["type"] == "lesson":
                    success_lesson_ids.append(p["id"])
                else:
                    success_skip_ids.append(p["id"])
            else:
                self.stdout.write(self.style.ERROR(
                    f"Giving up on {op_name} after {MAX_ATTEMPTS} attempts — "
                    f"next timer tick will pick it up"
                ))

        await bot.session.close()
        return success_lesson_ids, success_skip_ids

"""
Cron: `birthday_notify` (2026-08-27).

Раз в сутки в 00:00 Asia/Tashkent (host cron / systemd timer) пробегается
по активным операторам и, если сегодня совпадает с day/month у `birth_date`
и мы ещё не отправляли поздравление сегодня (`birthday_notified_on !=
today`), делает:

  1. In-app Notification для каждого manager/team_lead/superadmin.
     `kind = NotificationKind.BIRTHDAY`,
     `metadata = {operator_id, operator_name, age, birth_date}`.
     Bell-icon в CRM подхватит без миграции.

  2. TG DM тем менеджерам, у кого есть `BotSubscription` — тот же
     паттерн, что у `send_daily_manager_report`. Текст двуязычный:
     русский + узбекский в одном сообщении, чтобы не выяснять
     preferred_language менеджера.

  3. Помечает `operator.birthday_notified_on = today` — idempotency guard.
     Повторный запуск команды за тот же день пропустит оператора.

Флаги:
  --dry-run — печатает что бы отправило, но БД не мутирует и DM не шлёт.
  --date YYYY-MM-DD — переопределить «сегодня» (для тестов /
    ручного backfill'a пропущенного дня).

Edge-cases:
  - 29 февраля → в невисокосный год оператор попадает в выборку 28 фев
    (см. `operators_with_birthday_today`).
  - Inactive/deleted операторы исключены на уровне селектора.
  - При падении TG DM (или отсутствии `BotSubscription`) Notification всё
    равно создаётся — менеджер увидит уведомление в bell-icon.
  - Если менеджеров нет вообще — ничего не отправляем, но флаг ставим
    (чтобы cron не крутил впустую).

Prod-safety: `birth_date=None` по умолчанию → пока никто не заполнил
дату, cron ничего не делает. Feature полностью opt-in через заполнение
поля.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import logging

from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand
from django.utils import timezone

from apps.notifications.models import Notification, NotificationKind
from apps.operators.models import Operator
from apps.operators.selectors import _age_years, operators_with_birthday_today
from apps.users.models import Profile, Role

logger = logging.getLogger("operators.birthday_notify")

User = get_user_model()


def _build_tg_message(operator_name: str, age: int) -> str:
    """HTML для aiogram parse_mode='HTML'. RU + UZ в одном сообщении."""
    return (
        f"🎂 <b>Сегодня день рождения у {operator_name}!</b>\n"
        f"Ему/ей исполняется <b>{age}</b>. Не забудьте поздравить.\n\n"
        f"🎂 <b>Bugun {operator_name} tug'ilgan kuni!</b>\n"
        f"U <b>{age}</b> yoshga to'ldi. Tabriklashni unutmang."
    )


def _build_notification_title(operator_name: str) -> str:
    return f"🎂 Сегодня день рождения — {operator_name}"


def _build_notification_body(operator_name: str, age: int) -> str:
    return f"{operator_name} — {age} лет · Bugun {operator_name} — {age} yoshda"


async def _send_dm(chat_id: int, text: str, token: str) -> bool:
    try:
        from aiogram import Bot
    except ImportError:
        logger.warning("aiogram missing — DM skipped")
        return False
    bot = Bot(token=token)
    try:
        await bot.send_message(chat_id, text, parse_mode="HTML")
        return True
    except Exception as exc:
        logger.warning("birthday DM to chat=%s failed: %s", chat_id, exc)
        return False
    finally:
        try:
            await bot.session.close()
        except Exception:
            pass


class Command(BaseCommand):
    help = (
        "Notify managers about operators whose birthday is today. "
        "In-app Notification for every manager + TG DM via BotSubscription. "
        "Idempotent via Operator.birthday_notified_on."
    )

    def add_arguments(self, parser):
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="Do not touch DB / do not send DM; just print what would happen.",
        )
        parser.add_argument(
            "--date",
            type=str,
            default=None,
            help="Override 'today' (YYYY-MM-DD). Useful for tests / backfill of a missed day.",
        )

    def handle(self, *args, **opts):
        dry_run: bool = bool(opts.get("dry_run"))
        raw_date: str | None = opts.get("date")
        if raw_date:
            try:
                today = dt.date.fromisoformat(raw_date)
            except ValueError:
                self.stderr.write(f"Invalid --date value: {raw_date!r} (expected YYYY-MM-DD)")
                return
        else:
            today = timezone.localdate()

        # Selector already filters active/trainee + non-null birth_date +
        # 29 fev edge-case matching.
        operators = list(operators_with_birthday_today(today=today))

        # Filter out already-notified today.
        pending = [op for op in operators if op.birthday_notified_on != today]

        if not pending:
            self.stdout.write(
                f"birthday_notify: today={today.isoformat()} — no pending operators "
                f"({len(operators)} matched, all already notified today)"
            )
            return

        # Managers = recipients of in-app Notification.
        manager_users = list(
            User.objects.filter(
                profile__role__in=(Role.MANAGER, Role.TEAM_LEAD, Role.SUPERADMIN),
                is_active=True,
            )
        )
        # TG DM recipients — менеджеры, у которых Profile.telegram_user_id
        # заполнен (через /link'/link_operator FSM). Это тот же источник,
        # что и у reminder'ов (см. `attendance_checkout_reminder._process_one`).
        # BotSubscription не подходит — таблица per-chat, не per-user.
        tg_chat_ids: list[int] = list(
            Profile.objects.filter(
                role__in=(Role.MANAGER, Role.TEAM_LEAD, Role.SUPERADMIN),
                telegram_user_id__isnull=False,
                user__is_active=True,
            ).values_list("telegram_user_id", flat=True)
        )

        from django.conf import settings as _settings

        tg_token = getattr(_settings, "TELEGRAM_BOT_TOKEN", "") or ""

        self.stdout.write(
            f"birthday_notify: today={today.isoformat()} operators={len(pending)} "
            f"managers={len(manager_users)} tg_recipients={len(tg_chat_ids)} dry_run={dry_run}"
        )

        for op in pending:
            age = _age_years(op.birth_date, today)
            title = _build_notification_title(op.full_name)
            body = _build_notification_body(op.full_name, age)
            tg_text = _build_tg_message(op.full_name, age)
            self.stdout.write(
                f"  op#{op.id} {op.full_name} — age={age}, notifications={len(manager_users)}, "
                f"tg_dms={len(tg_chat_ids) if tg_token else 0}"
            )
            if dry_run:
                continue

            # 1. In-app Notifications (bulk).
            if manager_users:
                try:
                    Notification.objects.bulk_create(
                        [
                            Notification(
                                recipient=m,
                                kind=NotificationKind.BIRTHDAY,
                                title=title,
                                body=body,
                                link=f"/operators/{op.id}",
                                metadata={
                                    "kind": "birthday",
                                    "operator_id": op.id,
                                    "operator_name": op.full_name,
                                    "age": age,
                                    "birth_date": op.birth_date.isoformat(),
                                },
                            )
                            for m in manager_users
                        ]
                    )
                except Exception:
                    logger.exception("birthday_notify: Notification bulk_create failed op=%s", op.id)

            # 2. TG DM (best-effort — не блокируем idempotency guard).
            if tg_token and tg_chat_ids:
                for chat_id in tg_chat_ids:
                    try:
                        asyncio.run(_send_dm(chat_id, tg_text, tg_token))
                    except Exception:
                        logger.exception(
                            "birthday_notify: TG DM failed op=%s chat=%s", op.id, chat_id
                        )

            # 3. Idempotency guard.
            op.birthday_notified_on = today
            op.save(update_fields=["birthday_notified_on", "updated_at"])

        self.stdout.write(self.style.SUCCESS(f"birthday_notify: done ({len(pending)} operators)"))

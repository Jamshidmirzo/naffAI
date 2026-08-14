"""
Идемпотентная management-команда для создания/обновления
супер-админского аккаунта.

Пример:
    python manage.py create_superadmin \\
        --phone +998955554727 --login opercoder --password opercoder

Логика:
  - если User с таким `--login` уже есть — сбрасывает пароль на
    указанный, поднимает роль до `superadmin`, восстанавливает
    is_active=True;
  - если пользователя нет — создаёт нового; Profile тоже создаётся
    или обновляется;
  - `--phone` сохраняется в `Profile.telegram_user_id`? Нет — телефон
    у нас не хранится на Profile; поле только в Operator. Superadmin
    к Operator не привязан. Логин по `--login`, номер выводится
    только в success-сообщение (передаётся для наглядности —
    может использоваться менеджером как альтернативный "красивый"
    идентификатор при рассылках/поддержке).

Работает и локально, и внутри `docker compose exec web`.
"""

from __future__ import annotations

from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from apps.users.models import Profile, Role
from apps.users.services import user_password_set

User = get_user_model()


class Command(BaseCommand):
    help = "Create or upsert a superadmin user (role=superadmin)"

    def add_arguments(self, parser) -> None:
        parser.add_argument("--login", required=True, help="username, e.g. opercoder")
        parser.add_argument(
            "--password", required=True, help="plaintext password (>=8 chars)"
        )
        parser.add_argument(
            "--phone",
            required=False,
            default="",
            help="справочный номер для логов/UI (не сохраняется в БД)",
        )
        parser.add_argument(
            "--full-name",
            required=False,
            default="",
            help="Опциональное первое имя / полное имя. Пишется в user.first_name.",
        )

    @transaction.atomic
    def handle(self, *args, **opts) -> None:
        login: str = opts["login"].strip()
        password: str = opts["password"]
        phone: str = (opts.get("phone") or "").strip()
        full_name: str = (opts.get("full_name") or "").strip()

        if not login:
            raise CommandError("--login required")
        if len(password) < 8:
            raise CommandError("--password must be at least 8 chars")

        user, created = User.objects.get_or_create(
            username=login,
            defaults={"is_active": True, "first_name": full_name},
        )

        if not created:
            # Reactivate if previously blocked, refresh display name.
            changed_fields = []
            if not user.is_active:
                user.is_active = True
                changed_fields.append("is_active")
            if full_name and user.first_name != full_name:
                user.first_name = full_name
                changed_fields.append("first_name")
            if changed_fields:
                user.save(update_fields=changed_fields)

        # Reset password every run — makes команда безопасной для повторов
        # («забыл пароль» — заново запускаем ту же строку).
        user_password_set(user=user, plain=password)

        profile, _ = Profile.objects.update_or_create(
            user=user,
            defaults={"role": Role.SUPERADMIN},
        )

        action = "created" if created else "updated"
        self.stdout.write(
            self.style.SUCCESS(
                f"Superadmin {action}: username={login!r}"
                + (f", phone={phone!r}" if phone else "")
                + f", role={profile.role}"
            )
        )

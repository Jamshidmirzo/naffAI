"""
Идемпотентная management-команда для создания/обновления
супер-админского аккаунта.

Пример:
    python manage.py create_superadmin \\
        --phone +998955554727 --password opercoder --full-name 'Super Admin'

Логика:
  - `--phone` нормализуется в `+998XXXXXXXXX` и используется как
    `User.username`. Логин superadmin'а === его телефон, чтобы работать
    через тот же вход, что и операторы (LoginApi уже умеет phone→username
    lookup через `normalize_uz_phone`).
  - если User с таким username уже есть — сбрасывает пароль на
    указанный, поднимает роль до `superadmin`, восстанавливает
    is_active=True;
  - если пользователя нет — создаёт нового; Profile тоже создаётся
    или обновляется;
  - `--full-name` пишется в `user.first_name` (для UI).

Работает и локально, и внутри `docker compose exec web`.
"""

from __future__ import annotations

from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from apps.common.validators import normalize_uz_phone
from apps.users.models import Profile, Role
from apps.users.services import user_password_set

User = get_user_model()


class Command(BaseCommand):
    help = "Create or upsert a superadmin user (role=superadmin). username == phone."

    def add_arguments(self, parser) -> None:
        parser.add_argument(
            "--phone",
            required=True,
            help="Номер в формате +998XXXXXXXXX. Используется как username.",
        )
        parser.add_argument(
            "--password", required=True, help="plaintext password (>=8 chars)"
        )
        parser.add_argument(
            "--full-name",
            required=False,
            default="",
            help="Опциональное полное имя. Пишется в user.first_name.",
        )

    @transaction.atomic
    def handle(self, *args, **opts) -> None:
        raw_phone: str = (opts["phone"] or "").strip()
        password: str = opts["password"]
        full_name: str = (opts.get("full_name") or "").strip()

        normalized, valid = normalize_uz_phone(raw_phone)
        if not valid:
            raise CommandError(
                f"--phone {raw_phone!r} не валиден. Ожидается +998XXXXXXXXX."
            )
        if len(password) < 8:
            raise CommandError("--password must be at least 8 chars")

        username = normalized

        user, created = User.objects.get_or_create(
            username=username,
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
                f"Superadmin {action}: username={username!r} "
                f"(phone), role={profile.role}"
            )
        )

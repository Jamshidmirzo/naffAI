"""
Re-encrypt every OperatorSecret row under a new key version.

Usage::

    # Rotate every row from whatever version it currently uses to v2:
    python manage.py rotate_operator_secrets --to-version 2

    # Rotate only rows currently at v1:
    python manage.py rotate_operator_secrets --from-version 1 --to-version 2

    # Dry-run (report what would happen):
    python manage.py rotate_operator_secrets --to-version 2 --dry-run

Prerequisites: the target version must be present in
``OPERATOR_PASSWORD_ENCRYPTION_KEYS``. Runs each row inside its own
transaction so a partial failure leaves the rest intact.
"""

from __future__ import annotations

from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from apps.common.crypto import FernetVaultError, operator_password_vault
from apps.users.models import OperatorSecret


class Command(BaseCommand):
    help = "Re-encrypt OperatorSecret rows under a new Fernet key version"

    def add_arguments(self, parser) -> None:  # type: ignore[no-untyped-def]
        parser.add_argument(
            "--to-version",
            type=int,
            required=True,
            help="Target key version (must exist in OPERATOR_PASSWORD_ENCRYPTION_KEYS).",
        )
        parser.add_argument(
            "--from-version",
            type=int,
            default=None,
            help="Only rotate rows currently at this version. Default: all rows.",
        )
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="Report what would be rotated without touching the DB.",
        )

    def handle(self, *args, **options) -> None:  # type: ignore[no-untyped-def]
        to_version: int = options["to_version"]
        from_version: int | None = options["from_version"]
        dry_run: bool = options["dry_run"]

        qs = OperatorSecret.objects.all()
        if from_version is not None:
            qs = qs.filter(key_version=from_version)
        # Exclude rows already at the target version — no-op saves would be waste.
        qs = qs.exclude(key_version=to_version)

        total = qs.count()
        self.stdout.write(f"Rotation target: v{to_version}")
        self.stdout.write(f"Rows to re-encrypt: {total}")

        if total == 0:
            self.stdout.write(self.style.SUCCESS("Nothing to do."))
            return

        rotated = 0
        failed = 0
        for row in qs.iterator(chunk_size=500):
            try:
                with transaction.atomic():
                    new_cipher, new_version = operator_password_vault.reencrypt(
                        row.encrypted_password,
                        from_version=row.key_version,
                        to_version=to_version,
                    )
                    if dry_run:
                        rotated += 1
                        continue
                    row.encrypted_password = new_cipher
                    row.key_version = new_version
                    row.save(update_fields=["encrypted_password", "key_version", "updated_at"])
                    rotated += 1
            except FernetVaultError as exc:
                failed += 1
                self.stderr.write(
                    self.style.ERROR(
                        f"secret user={row.user_id} v{row.key_version}: {exc}"
                    )
                )

        prefix = "[DRY-RUN] " if dry_run else ""
        self.stdout.write(
            self.style.SUCCESS(f"{prefix}rotated: {rotated}, failed: {failed}")
        )
        if failed:
            raise CommandError(f"{failed} row(s) could not be rotated")

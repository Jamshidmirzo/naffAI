"""
Load TAC -> brand/model mapping into the local lookup table.

Supports two sources:
  - --file <path.csv|.json>  Local file (recommended for prod)
  - --builtin                Tiny built-in seed of popular Apple/Samsung/Xiaomi models

CSV columns expected (case-insensitive): tac, brand, model, [device_type]
JSON: list of {tac, brand, model, device_type?}

For larger datasets:
  - Osmocom: https://tacdb.osmocom.org/
  - GitHub: https://github.com/MoazEb/tac-database
"""

from __future__ import annotations

import csv
import json
from pathlib import Path

from django.core.management.base import BaseCommand, CommandError

from apps.catalog.models import TacLookup

BUILTIN_TAC: list[dict] = [
    # iPhone 13 (selected real TACs)
    {"tac": "35676211", "brand": "Apple", "model": "iPhone 13", "device_type": "smartphone"},
    {"tac": "35330411", "brand": "Apple", "model": "iPhone 13 Pro", "device_type": "smartphone"},
    {"tac": "35266911", "brand": "Apple", "model": "iPhone 14", "device_type": "smartphone"},
    {"tac": "35324111", "brand": "Apple", "model": "iPhone 14 Pro", "device_type": "smartphone"},
    {"tac": "35332811", "brand": "Apple", "model": "iPhone 15", "device_type": "smartphone"},
    {"tac": "35325011", "brand": "Apple", "model": "iPhone 15 Pro", "device_type": "smartphone"},
    {
        "tac": "35457111",
        "brand": "Apple",
        "model": "iPhone 15 Pro Max",
        "device_type": "smartphone",
    },
    # Samsung Galaxy S series
    {"tac": "35498910", "brand": "Samsung", "model": "Galaxy S21", "device_type": "smartphone"},
    {"tac": "35341111", "brand": "Samsung", "model": "Galaxy S22", "device_type": "smartphone"},
    {"tac": "35377511", "brand": "Samsung", "model": "Galaxy S23", "device_type": "smartphone"},
    {"tac": "35356511", "brand": "Samsung", "model": "Galaxy S24", "device_type": "smartphone"},
    {"tac": "35450911", "brand": "Samsung", "model": "Galaxy A54", "device_type": "smartphone"},
    # Xiaomi
    {"tac": "86412105", "brand": "Xiaomi", "model": "Redmi Note 12", "device_type": "smartphone"},
    {"tac": "86880506", "brand": "Xiaomi", "model": "Redmi Note 13", "device_type": "smartphone"},
    {"tac": "86731006", "brand": "Xiaomi", "model": "Xiaomi 13", "device_type": "smartphone"},
    # Google
    {"tac": "35341212", "brand": "Google", "model": "Pixel 7", "device_type": "smartphone"},
    {"tac": "35355212", "brand": "Google", "model": "Pixel 8", "device_type": "smartphone"},
]


class Command(BaseCommand):
    help = "Seed/update the TAC lookup table from a file or built-in dataset."

    def add_arguments(self, parser):
        parser.add_argument("--file", type=str, default=None)
        parser.add_argument("--builtin", action="store_true")
        parser.add_argument("--truncate", action="store_true", help="Drop existing rows first")

    def handle(self, *args, **opts):
        if not opts["file"] and not opts["builtin"]:
            raise CommandError("Specify --file <path> or --builtin")

        rows = self._load_builtin() if opts["builtin"] else self._load_file(opts["file"])

        if opts["truncate"]:
            TacLookup.objects.all().delete()
            self.stdout.write(self.style.WARNING("Truncated existing TAC rows"))

        created, updated = 0, 0
        for row in rows:
            tac = str(row["tac"]).strip().zfill(8)
            _, was_created = TacLookup.objects.update_or_create(
                tac=tac,
                defaults={
                    "brand": (row.get("brand") or "").strip()[:64],
                    "model": (row.get("model") or "").strip()[:128],
                    "device_type": (row.get("device_type") or "").strip()[:32],
                },
            )
            created += int(was_created)
            updated += int(not was_created)

        self.stdout.write(
            self.style.SUCCESS(
                f"TAC seed: +{created} new, {updated} updated, total {TacLookup.objects.count()}"
            )
        )

    def _load_builtin(self) -> list[dict]:
        return BUILTIN_TAC

    def _load_file(self, path: str) -> list[dict]:
        p = Path(path)
        if not p.exists():
            raise CommandError(f"File not found: {path}")
        suffix = p.suffix.lower()
        if suffix == ".json":
            return json.loads(p.read_text())
        if suffix == ".csv":
            with p.open(newline="") as f:
                reader = csv.DictReader(f)
                return [{k.lower(): v for k, v in row.items()} for row in reader]
        raise CommandError(f"Unsupported file type: {suffix}")

"""
Seed initial `SheetSource` rows for the customer's spreadsheet and place-
holder `OperatorSheetAlias` rows so the admin can bind them to real
operators without waiting for the first sync.

Idempotent — safe to run repeatedly. Uses `sheet_source_upsert` and
`operator_alias_upsert` so audit entries are consistent with runtime
edits.
"""

from __future__ import annotations

from django.core.management.base import BaseCommand

from apps.leads.models import LeadStatus
from apps.leads.services import operator_alias_upsert, sheet_source_upsert


SPREADSHEET_ID = "140JC8hXXhI1VqBcsZK8yWvBZ05a4NOV7OiNKCz007W0"

SHEET_1_COLUMN_MAP = {
    "full_name": "full_name",
    "phone": "phone_number",
    "product_hint": "qanday_telefon_xarid_qilmoqchisiz?",
    "has_card": "plastik_kartangiz_bormi?",
    # Sheet 1's operator column has no header — take by position (5th col).
    "operator_alias": {"column_index": 5},
}

SHEET_2_COLUMN_MAP = {
    "full_name": "3. Full name",
    "phone": "4. Phone number",
    "product_hint": "2. Qanday telefon xarid qilmoqchisiz?",
    "has_card": "1. Plastik kartangiz bormi?",
    "operator_alias": {"column_index": 5},
    "extra": ["date"],
}

SHEET_3_COLUMN_MAP = {
    "full_name": "ismingiz:",
    "phone": "telefon_raqamingiz",
    "product_hint": "qanday_telefon_olmoqchisiz?",
    "extra": [
        "phone_number",
        "ISM",
        "STATUS",
        "IZOH",
        "bitrix_status",
        "bitrix_contact_id",
        "bitrix_deal_id",
        "bitrix_error",
        "processed_at",
    ],
}


PLACEHOLDER_ALIASES = ["Nihola", "Sevara", "Yasmina", "Abdulaziz"]


class Command(BaseCommand):
    help = "Seed default SheetSource rows and placeholder operator aliases."

    def handle(self, *args, **opts) -> None:
        sources = [
            {
                "name": "Sheet 1 — swap form v1",
                "gid": 2041870110,
                "column_map": SHEET_1_COLUMN_MAP,
                "default_status": LeadStatus.NEW,
            },
            {
                "name": "Sheet 2 — swap form v2",
                "gid": 523288785,
                "column_map": SHEET_2_COLUMN_MAP,
                "default_status": LeadStatus.NEW,
            },
            {
                "name": "Sheet 3 — Bitrix archive",
                "gid": 1712070933,
                "column_map": SHEET_3_COLUMN_MAP,
                "default_status": LeadStatus.ARCHIVED,
            },
        ]
        for src in sources:
            obj = sheet_source_upsert(
                name=src["name"],
                spreadsheet_id=SPREADSHEET_ID,
                gid=src["gid"],
                column_map=src["column_map"],
                default_status=src["default_status"],
            )
            self.stdout.write(
                self.style.SUCCESS(
                    f"SheetSource#{obj.id} name={obj.name!r} gid={obj.gid} "
                    f"default_status={obj.default_status}"
                )
            )

        for alias in PLACEHOLDER_ALIASES:
            obj = operator_alias_upsert(alias_name=alias, operator=None)
            self.stdout.write(f"OperatorSheetAlias#{obj.id} {obj.alias_name} → unbound")

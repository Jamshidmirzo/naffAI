"""
Seed 5 default BotReportTemplate rows — the presets shown in the
"Из шаблона" gallery when creating a new report. Idempotent: upserts
by slug, so re-running the command refreshes labels + block lists
without breaking existing BotReport rows (templates are one-way copies
into the editor form, never linked).

Usage:
    python manage.py seed_bot_templates
    python manage.py seed_bot_templates --reset   # wipe & re-create
"""

from __future__ import annotations

from django.core.management.base import BaseCommand
from django.db import transaction

from apps.tg_bot.models import BotReportTemplate

TEMPLATES: list[dict] = [
    {
        "slug": "morning",
        "name": "Утренняя сводка",
        "description": "Смена, pending, callback'и, топ вчера",
        "category": "morning",
        "sort_order": 10,
        "blocks": [
            "morning_digest",
            "top_operators",
            "callbacks_overdue",
            "pending_sales",
        ],
        "schedule_defaults": {
            "schedule_time": "09:00:00",
            "schedule_days": [],  # every day
            "period": "today",
            "include_header": True,
            "language": "ru",
        },
    },
    {
        "slug": "evening",
        "name": "Вечерний отчёт",
        "description": "Итоги дня: продажи, каналы, динамика",
        "category": "evening",
        "sort_order": 20,
        "blocks": [
            "sales_total",
            "top_operators",
            "top_partners",
            "wow_growth",
            "average_check",
        ],
        "schedule_defaults": {
            "schedule_time": "20:00:00",
            "schedule_days": [],
            "period": "today",
            "include_header": True,
            "language": "ru",
        },
    },
    {
        "slug": "weekly",
        "name": "Недельный обзор",
        "description": "По понедельникам — итоги прошлой недели",
        "category": "weekly",
        "sort_order": 30,
        "blocks": [
            "sales_total",
            "wow_growth",
            "funnel",
            "operator_ranking_multi",
            "hot_items",
        ],
        "schedule_defaults": {
            "schedule_time": "09:00:00",
            "schedule_days": ["mon"],
            "period": "week",
            "include_header": True,
            "language": "ru",
        },
    },
    {
        "slug": "owner",
        "name": "Владельцу магазина",
        "description": "Sensitive-блоки: возвраты, скидки, payroll (только в личку)",
        "category": "owner",
        "sort_order": 40,
        "blocks": [
            "sales_total",
            "payroll_progress",
            "returns_summary",
            "discount_leakage",
            "callback_backlog",
            "stale_leads",
        ],
        "schedule_defaults": {
            "schedule_time": "21:00:00",
            "schedule_days": [],
            "period": "today",
            "include_header": True,
            "language": "ru",
        },
    },
    {
        "slug": "activity",
        "name": "Дневная активность",
        "description": "Смена сейчас + активность звонков + топ",
        "category": "operator",
        "sort_order": 50,
        "blocks": [
            "shift_status",
            "call_volume",
            "top_operators",
            "daily_quote",
        ],
        "schedule_defaults": {
            "schedule_time": "13:00:00",
            "schedule_days": ["mon", "tue", "wed", "thu", "fri", "sat"],
            "period": "today",
            "include_header": True,
            "language": "ru",
        },
    },
]


class Command(BaseCommand):
    help = "Upsert built-in BotReportTemplate presets. Idempotent by slug."

    def add_arguments(self, parser):
        parser.add_argument(
            "--reset",
            action="store_true",
            help="Delete all templates first, then re-create from scratch.",
        )

    @transaction.atomic
    def handle(self, *args, **opts):
        if opts.get("reset"):
            n = BotReportTemplate.objects.all().delete()[0]
            self.stdout.write(self.style.WARNING(f"[seed] wiped {n} rows"))

        created = 0
        updated = 0
        for spec in TEMPLATES:
            _obj, was_created = BotReportTemplate.objects.update_or_create(
                slug=spec["slug"],
                defaults={
                    "name": spec["name"],
                    "description": spec["description"],
                    "category": spec["category"],
                    "sort_order": spec["sort_order"],
                    "blocks": spec["blocks"],
                    "schedule_defaults": spec["schedule_defaults"],
                    "is_active": True,
                },
            )
            if was_created:
                created += 1
            else:
                updated += 1

        self.stdout.write(
            self.style.SUCCESS(
                f"[seed] templates: created={created} updated={updated} "
                f"total={BotReportTemplate.objects.count()}"
            )
        )

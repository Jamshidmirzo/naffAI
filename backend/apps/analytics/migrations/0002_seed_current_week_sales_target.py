"""
Seed a default weekly SalesTarget so that the manager dashboard shows a
plan-vs-actual hint from the moment the feature is deployed.

Idempotent — uses `get_or_create` on `(period_type, period_start)`.
"""
from __future__ import annotations

import datetime as dt
from decimal import Decimal

from django.db import migrations


def _current_week_monday() -> dt.date:
    today = dt.date.today()
    return today - dt.timedelta(days=today.weekday())


def seed_weekly_target(apps, schema_editor):
    SalesTarget = apps.get_model("analytics", "SalesTarget")
    SalesTarget.objects.get_or_create(
        period_type="weekly",
        period_start=_current_week_monday(),
        defaults={
            "target_amount": Decimal("140000000"),  # 140 млн UZS
            "target_count": 18 * 7,  # 18 шт./день × 7 дней = 126 шт./неделя
            "note": "Seed: default weekly plan (see analytics migration 0002).",
        },
    )


def unseed(apps, schema_editor):
    # Не откатываем — план могли уже подправить руками. Только удалим
    # ровно нашу сид-строку, если её не трогали (нулевой note-guard).
    SalesTarget = apps.get_model("analytics", "SalesTarget")
    SalesTarget.objects.filter(
        period_type="weekly",
        period_start=_current_week_monday(),
        note__startswith="Seed:",
    ).delete()


class Migration(migrations.Migration):

    dependencies = [
        ("analytics", "0001_initial"),
    ]

    operations = [
        migrations.RunPython(seed_weekly_target, unseed),
    ]

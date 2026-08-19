"""
Seed defaults for InstallmentTier (6 rows) + MarketingSettings singleton.

Idempotent — reruns are safe. Uses `apps.get_model` per Django data-migration
best practice so a future rename of the model class doesn't break history.
"""

from __future__ import annotations

from decimal import Decimal

from django.db import migrations

TIERS = [
    # (months, commission_pct, show_in_marketing, sort_order)
    (1, "7.00", False, 10),
    (3, "15.00", False, 20),
    (6, "25.00", True, 30),
    (9, "32.00", False, 40),
    (12, "38.00", True, 50),
    (15, "50.00", True, 60),
]

DEFAULT_MARKETING = {
    "default_tagline": "Yuqori sifat va yuqori mustahkamlik!",
    "phone_primary": "+998 88 750 20 53",
    "phone_secondary": "+998 88 750 20 42",
    "telegram_handle": "@naff_ss",
    "address": "Yunusobod, 11-k.",
    "benefits": (
        "👎 Boshlang'ich to'lovsiz\n"
        "💳 Pasport + Plastik karta kifoya\n"
        "🚚 Bepul yetkazib berish O'zbekiston bo'ylab\n"
        "❌ Penya yo'q\n"
        "⚙️ 1 yillik garantiya"
    ),
}


def seed(apps, schema_editor):
    InstallmentTier = apps.get_model("catalog", "InstallmentTier")
    MarketingSettings = apps.get_model("catalog", "MarketingSettings")

    for months, pct, show, sort_order in TIERS:
        InstallmentTier.objects.update_or_create(
            months=months,
            defaults={
                "commission_pct": Decimal(pct),
                "is_active": True,
                "show_in_marketing": show,
                "sort_order": sort_order,
            },
        )

    # MarketingSettings is a singleton (save() forces pk=1) but historical
    # models don't call the runtime save() override — we set pk explicitly.
    settings, created = MarketingSettings.objects.get_or_create(
        pk=1, defaults=DEFAULT_MARKETING
    )
    if not created:
        # Only fill blank fields on re-run — don't overwrite manager edits.
        dirty = False
        for field, value in DEFAULT_MARKETING.items():
            if not getattr(settings, field):
                setattr(settings, field, value)
                dirty = True
        if dirty:
            settings.save()


def unseed(apps, schema_editor):
    InstallmentTier = apps.get_model("catalog", "InstallmentTier")
    MarketingSettings = apps.get_model("catalog", "MarketingSettings")
    InstallmentTier.objects.filter(months__in=[m for m, *_ in TIERS]).delete()
    MarketingSettings.objects.filter(pk=1).delete()


class Migration(migrations.Migration):

    dependencies = [
        ("catalog", "0003_extended_catalog_and_marketing"),
    ]

    operations = [
        migrations.RunPython(seed, unseed),
    ]

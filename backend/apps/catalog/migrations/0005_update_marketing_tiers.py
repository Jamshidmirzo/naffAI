"""
Marketing-tier adjustment: showcase 6/12/24 months in the copy-to-clipboard
template instead of 6/12/15. Adds a 24-month tier with a starter commission
of 75% (extrapolated from the reference Honor X8D card the operator team
uses — manager can tune it via /catalog/tiers). Demotes the 15-month tier
from `show_in_marketing` so it stays available in the calculator but stops
appearing in outbound quotes.

Idempotent: safe to re-run.
"""

from __future__ import annotations

from decimal import Decimal

from django.db import migrations


TIER_24 = {
    "months": 24,
    "commission_pct": Decimal("75.00"),
    "is_active": True,
    "show_in_marketing": True,
    "sort_order": 70,
}


def apply(apps, schema_editor):
    Tier = apps.get_model("catalog", "InstallmentTier")
    Tier.objects.update_or_create(months=24, defaults=TIER_24)
    Tier.objects.filter(months=15).update(show_in_marketing=False)


def revert(apps, schema_editor):
    Tier = apps.get_model("catalog", "InstallmentTier")
    Tier.objects.filter(months=24).delete()
    Tier.objects.filter(months=15).update(show_in_marketing=True)


class Migration(migrations.Migration):

    dependencies = [
        ("catalog", "0004_seed_installment_tiers_and_marketing"),
    ]

    operations = [
        migrations.RunPython(apply, revert),
    ]

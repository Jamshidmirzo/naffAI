"""
Drop `SaleAssignedManager` — «manager-partners» were the wrong feature
scope. Business asked for multi-channel payment split (SalePartner
already exists), not a co-ownership tag.

`SaleContractPhoto` from 0011 stays intact — the multi-photo gallery
is the right long-term shape and there may already be rows in prod.

Safe to run: table is confirmed empty in prod as of 2026-08-18
(no rows written yet — 0011 was live for a few hours before the roll-
back). No FK references from other apps.
"""

from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ("sales", "0011_assigned_managers_and_multi_photos"),
    ]

    operations = [
        migrations.DeleteModel(
            name="SaleAssignedManager",
        ),
    ]

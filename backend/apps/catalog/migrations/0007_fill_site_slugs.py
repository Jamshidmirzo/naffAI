"""
Fill `PhoneModel.site_slug` for rows that existed before 0006.

Same rule as `models.phone_site_slug_base` (`apple-iphone-16-pro-256gb`,
`-2`, `-3`… on collision), copied here on purpose — a migration must not
change behaviour if the runtime helper changes later. Idempotent: only
rows with an empty slug are touched.
"""

from __future__ import annotations

from django.db import migrations
from django.utils.text import slugify

SLUG_MAX_LENGTH = 160


def _base(phone) -> str:
    parts = [phone.brand or "", phone.model_name or ""]
    if phone.storage_gb:
        parts.append(f"{phone.storage_gb}gb")
    base = slugify(" ".join(parts))[: SLUG_MAX_LENGTH - 8].strip("-")
    return base or "phone"


def fill(apps, schema_editor):
    PhoneModel = apps.get_model("catalog", "PhoneModel")
    taken = set(
        PhoneModel.objects.exclude(site_slug__isnull=True)
        .exclude(site_slug="")
        .values_list("site_slug", flat=True)
    )
    pending = PhoneModel.objects.filter(site_slug__isnull=True) | PhoneModel.objects.filter(
        site_slug=""
    )
    for phone in pending.order_by("id"):
        base = _base(phone)
        slug, n = base, 2
        while slug in taken:
            slug = f"{base}-{n}"
            n += 1
        taken.add(slug)
        PhoneModel.objects.filter(pk=phone.pk).update(site_slug=slug)


class Migration(migrations.Migration):

    dependencies = [
        ("catalog", "0006_public_site_and_spin"),
    ]

    operations = [
        migrations.RunPython(fill, migrations.RunPython.noop),
    ]

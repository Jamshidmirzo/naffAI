"""
Extended catalog + marketing singleton + global installment tiers.

Adds optional descriptive fields to PhoneModel (tagline, camera_mp,
battery_mah, specs_json), a PhoneGalleryPhoto side-table for extra
product photos, a shop-wide InstallmentTier table used by the calculator
and marketing template, and a MarketingSettings singleton for contact
info / benefits.

All new PhoneModel fields are nullable / defaulted so the pre-catalog
v2 prod frontend (which never sends them) keeps working unchanged.
"""

from __future__ import annotations

import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("catalog", "0002_catalog_v1"),
    ]

    operations = [
        # --- PhoneModel: 4 optional descriptive fields ---
        migrations.AddField(
            model_name="phonemodel",
            name="tagline",
            field=models.CharField(blank=True, default="", max_length=200),
        ),
        migrations.AddField(
            model_name="phonemodel",
            name="camera_mp",
            field=models.PositiveSmallIntegerField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="phonemodel",
            name="battery_mah",
            field=models.PositiveIntegerField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="phonemodel",
            name="specs_json",
            field=models.JSONField(blank=True, default=dict),
        ),
        # --- Gallery ---
        migrations.CreateModel(
            name="PhoneGalleryPhoto",
            fields=[
                (
                    "id",
                    models.BigAutoField(
                        auto_created=True,
                        primary_key=True,
                        serialize=False,
                        verbose_name="ID",
                    ),
                ),
                ("photo", models.ImageField(upload_to="catalog/gallery/%Y/%m/")),
                ("position", models.PositiveSmallIntegerField(default=0)),
                ("uploaded_at", models.DateTimeField(auto_now_add=True)),
                (
                    "phone",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="gallery",
                        to="catalog.phonemodel",
                    ),
                ),
            ],
            options={"ordering": ["position", "id"]},
        ),
        # --- Global installment tiers (for /calculator + marketing text) ---
        migrations.CreateModel(
            name="InstallmentTier",
            fields=[
                (
                    "id",
                    models.BigAutoField(
                        auto_created=True,
                        primary_key=True,
                        serialize=False,
                        verbose_name="ID",
                    ),
                ),
                ("months", models.PositiveSmallIntegerField(unique=True)),
                (
                    "commission_pct",
                    models.DecimalField(decimal_places=2, max_digits=5),
                ),
                ("is_active", models.BooleanField(default=True)),
                ("show_in_marketing", models.BooleanField(default=False)),
                ("sort_order", models.PositiveSmallIntegerField(default=0)),
            ],
            options={"ordering": ["sort_order", "months"]},
        ),
        # --- Marketing settings singleton ---
        migrations.CreateModel(
            name="MarketingSettings",
            fields=[
                (
                    "id",
                    models.BigAutoField(
                        auto_created=True,
                        primary_key=True,
                        serialize=False,
                        verbose_name="ID",
                    ),
                ),
                (
                    "default_tagline",
                    models.CharField(
                        default="Yuqori sifat va yuqori mustahkamlik!",
                        max_length=200,
                    ),
                ),
                (
                    "phone_primary",
                    models.CharField(blank=True, default="", max_length=32),
                ),
                (
                    "phone_secondary",
                    models.CharField(blank=True, default="", max_length=32),
                ),
                (
                    "telegram_handle",
                    models.CharField(blank=True, default="", max_length=64),
                ),
                (
                    "address",
                    models.CharField(blank=True, default="", max_length=200),
                ),
                (
                    "benefits",
                    models.TextField(
                        blank=True,
                        default="",
                        help_text=(
                            "Одна строка = один пункт. Первый символ строки — "
                            "эмодзи, дальше — текст."
                        ),
                    ),
                ),
                ("updated_at", models.DateTimeField(auto_now=True)),
            ],
            options={
                "verbose_name": "Marketing settings",
                "verbose_name_plural": "Marketing settings",
            },
        ),
    ]

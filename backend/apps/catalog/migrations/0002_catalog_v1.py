"""
Catalog v1 — phone models + color variants + installment banks/plans.
"""

from decimal import Decimal

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("catalog", "0001_initial"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name="PhoneModel",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("brand", models.CharField(db_index=True, max_length=64)),
                ("model_name", models.CharField(max_length=128)),
                ("storage_gb", models.PositiveSmallIntegerField(blank=True, null=True)),
                ("ram_gb", models.PositiveSmallIntegerField(blank=True, null=True)),
                ("price", models.DecimalField(decimal_places=2, max_digits=14)),
                ("cover_image", models.ImageField(blank=True, null=True, upload_to="catalog/phones/%Y/%m/")),
                ("description", models.TextField(blank=True, default="")),
                (
                    "stock_status",
                    models.CharField(
                        choices=[
                            ("available", "В наличии"),
                            ("on_order", "Под заказ"),
                            ("out", "Нет в наличии"),
                        ],
                        db_index=True,
                        default="available",
                        max_length=16,
                    ),
                ),
                ("is_active", models.BooleanField(db_index=True, default=True)),
                ("sort_order", models.IntegerField(default=0)),
                (
                    "created_by",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="created_phones",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
            ],
            options={
                "ordering": ["-sort_order", "brand", "model_name"],
                "indexes": [
                    models.Index(fields=["brand", "model_name"], name="catalog_pho_brand_9c7f83_idx")
                ],
            },
        ),
        migrations.CreateModel(
            name="PhoneColor",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("name", models.CharField(max_length=64)),
                ("hex_code", models.CharField(blank=True, default="", max_length=9)),
                ("price_override", models.DecimalField(blank=True, decimal_places=2, max_digits=14, null=True)),
                ("is_available", models.BooleanField(default=True)),
                ("sort_order", models.IntegerField(default=0)),
                (
                    "phone",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="colors",
                        to="catalog.phonemodel",
                    ),
                ),
            ],
            options={
                "ordering": ["sort_order", "name"],
                "constraints": [
                    models.UniqueConstraint(fields=("phone", "name"), name="uniq_phone_color"),
                ],
            },
        ),
        migrations.CreateModel(
            name="InstallmentBank",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("name", models.CharField(max_length=64, unique=True)),
                ("icon", models.CharField(blank=True, default="", max_length=8)),
                ("is_active", models.BooleanField(default=True)),
                ("sort_order", models.IntegerField(default=0)),
            ],
            options={"ordering": ["sort_order", "name"]},
        ),
        migrations.CreateModel(
            name="InstallmentPlan",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("term_months", models.PositiveSmallIntegerField()),
                (
                    "multiplier",
                    models.DecimalField(decimal_places=3, default=Decimal("1.000"), max_digits=5),
                ),
                ("is_active", models.BooleanField(default=True)),
                ("sort_order", models.IntegerField(default=0)),
                (
                    "bank",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="plans",
                        to="catalog.installmentbank",
                    ),
                ),
            ],
            options={
                "ordering": ["bank__sort_order", "term_months"],
                "constraints": [
                    models.UniqueConstraint(fields=("bank", "term_months"), name="uniq_bank_term"),
                ],
            },
        ),
    ]

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("leads", "0005_lead_extra_statuses"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name="LeadStatusLabel",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("code", models.CharField(max_length=64, unique=True)),
                ("label_ru", models.CharField(max_length=80)),
                ("label_uz", models.CharField(blank=True, default="", max_length=80)),
                (
                    "tone",
                    models.CharField(
                        choices=[
                            ("neutral", "нейтральный"),
                            ("hot", "оранжевый (акцент)"),
                            ("danger", "красный"),
                            ("success", "зелёный"),
                            ("info", "синий"),
                        ],
                        default="neutral",
                        max_length=16,
                    ),
                ),
                ("emoji", models.CharField(blank=True, default="", max_length=8)),
                ("sort_order", models.PositiveSmallIntegerField(default=100)),
                ("show_in_chip", models.BooleanField(default=True)),
                ("show_in_button", models.BooleanField(default=True)),
                ("is_active", models.BooleanField(default=True)),
                ("is_builtin", models.BooleanField(default=False)),
                (
                    "created_by",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="+",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
            ],
            options={
                "ordering": ["sort_order", "id"],
                "indexes": [
                    models.Index(fields=["is_active", "sort_order"], name="leadstatus_active_order_idx"),
                ],
            },
        ),
    ]

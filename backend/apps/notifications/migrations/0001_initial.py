import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    initial = True

    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name="Notification",
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
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                (
                    "kind",
                    models.CharField(
                        choices=[
                            ("sale_created", "Новая продажа"),
                            ("sale_returned", "Возврат продажи"),
                            ("callback_overdue", "Просроченный колбэк"),
                            ("lead_assigned", "Новый лид"),
                            ("system", "Системное сообщение"),
                        ],
                        db_index=True,
                        max_length=32,
                    ),
                ),
                ("title", models.CharField(max_length=280)),
                ("body", models.TextField(blank=True, default="")),
                (
                    "link",
                    models.CharField(
                        blank=True,
                        default="",
                        help_text="Relative frontend URL, e.g. /sales/123",
                        max_length=512,
                    ),
                ),
                ("read_at", models.DateTimeField(blank=True, db_index=True, null=True)),
                ("metadata", models.JSONField(blank=True, default=dict)),
                (
                    "recipient",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="notifications",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
            ],
            options={
                "ordering": ["-created_at"],
            },
        ),
        migrations.AddIndex(
            model_name="notification",
            index=models.Index(
                fields=["recipient", "-created_at"],
                name="notificatio_recipie_a972ce_idx",
            ),
        ),
        migrations.AddIndex(
            model_name="notification",
            index=models.Index(
                fields=["recipient", "read_at"],
                name="notificatio_recipie_564b1f_idx",
            ),
        ),
    ]

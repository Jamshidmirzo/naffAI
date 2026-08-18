"""
Initial analytics migration — SalesTarget only.

Analytics is historically a read-only package (see selectors.py). This
migration introduces the first analytics-owned data model: `SalesTarget`
— команда планирует сколько продать за день/неделю/месяц. Дашборд
использует ряд для плана-vs-факта.
"""
from django.db import migrations, models


class Migration(migrations.Migration):

    initial = True

    dependencies = []

    operations = [
        migrations.CreateModel(
            name="SalesTarget",
            fields=[
                (
                    "id",
                    models.BigAutoField(
                        auto_created=True, primary_key=True, serialize=False, verbose_name="ID"
                    ),
                ),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                (
                    "period_type",
                    models.CharField(
                        choices=[
                            ("daily", "День"),
                            ("weekly", "Неделя"),
                            ("monthly", "Месяц"),
                        ],
                        default="weekly",
                        max_length=8,
                    ),
                ),
                (
                    "period_start",
                    models.DateField(
                        help_text=(
                            "Календарный якорь: точная дата для DAILY, "
                            "понедельник — для WEEKLY, 1-е число — для MONTHLY."
                        )
                    ),
                ),
                (
                    "target_amount",
                    models.DecimalField(
                        decimal_places=2,
                        default=0,
                        help_text="Плановая сумма продаж (net, UZS) за период.",
                        max_digits=14,
                    ),
                ),
                (
                    "target_count",
                    models.PositiveIntegerField(
                        default=0,
                        help_text="Плановое число продаж (шт.) за период.",
                    ),
                ),
                ("note", models.CharField(blank=True, default="", max_length=200)),
            ],
            options={
                "ordering": ["-period_start", "period_type"],
                "indexes": [
                    models.Index(
                        fields=["period_type", "-period_start"],
                        name="analytics_s_period__f13c0c_idx",
                    ),
                ],
                "constraints": [
                    models.UniqueConstraint(
                        fields=["period_type", "period_start"],
                        name="uniq_sales_target_period",
                    ),
                ],
            },
        ),
    ]

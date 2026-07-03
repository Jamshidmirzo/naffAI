import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("operators", "0001_initial"),
    ]

    operations = [
        migrations.CreateModel(
            name="OperatorMonthlyPlan",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("year", models.PositiveSmallIntegerField()),
                ("month", models.PositiveSmallIntegerField()),
                ("target_amount", models.DecimalField(decimal_places=2, max_digits=16)),
                (
                    "operator",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="monthly_plans",
                        to="operators.operator",
                    ),
                ),
            ],
            options={
                "unique_together": {("operator", "year", "month")},
            },
        ),
    ]

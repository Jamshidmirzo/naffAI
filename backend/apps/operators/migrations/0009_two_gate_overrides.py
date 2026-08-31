# Generated for 2-gate payroll model (2026-08-31).
#
# Adds per-operator override fields matching the new AttendanceSettings
# defaults. All nullable — resolve_operator_config falls back to
# AttendanceSettings when unset. `salary_uzs` (0008) stays as a
# deprecated alias for `attendance_bonus_uzs` so legacy per-operator
# tweaks continue to work.

import django.core.validators
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("operators", "0008_payroll_overrides"),
    ]

    operations = [
        migrations.AddField(
            model_name="operator",
            name="attendance_bonus_uzs",
            field=models.DecimalField(
                blank=True,
                decimal_places=0,
                help_text=(
                    "Персональный бонус за attendance (UZS). "
                    "Пусто → salary_uzs → default_attendance_bonus_uzs."
                ),
                max_digits=12,
                null=True,
            ),
        ),
        migrations.AddField(
            model_name="operator",
            name="sales_bonus_uzs",
            field=models.DecimalField(
                blank=True,
                decimal_places=0,
                help_text=(
                    "Персональный бонус за продажи (UZS). "
                    "Пусто → default_sales_bonus_uzs."
                ),
                max_digits=12,
                null=True,
            ),
        ),
        migrations.AddField(
            model_name="operator",
            name="sales_gate_pct",
            field=models.PositiveSmallIntegerField(
                blank=True,
                help_text=(
                    "Персональный порог продаж (%%). "
                    "Пусто → default_sales_gate_pct."
                ),
                null=True,
                validators=[
                    django.core.validators.MinValueValidator(0),
                    django.core.validators.MaxValueValidator(100),
                ],
            ),
        ),
    ]

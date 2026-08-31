# Generated for 2-gate payroll model (2026-08-31).
#
# Adds AttendanceSettings-level defaults for:
#   - attendance-bonus block sum (default 1.5M UZS)
#   - sales-bonus block sum (default 1.5M UZS)
#   - sales-gate percent (default 85)
#   - monthly-plan fallback (when a specific operator has no OperatorMonthlyPlan)
#
# `default_salary_uzs` deliberately stays — resolve_operator_config keeps
# reading it as a secondary fallback so on-prod values seeded before the
# 2-gate cutover keep working while the manager migrates via UI.

from decimal import Decimal

import django.core.validators
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("attendance", "0008_payroll_defaults"),
    ]

    operations = [
        migrations.AddField(
            model_name="attendancesettings",
            name="default_attendance_bonus_uzs",
            field=models.DecimalField(
                decimal_places=0,
                default=Decimal("1500000"),
                help_text=(
                    "Бонус за attendance по умолчанию (UZS). Выдаётся полностью, "
                    "если посещаемость ≥ гейта; иначе 0. Штрафы за опоздания "
                    "вычитаются только когда гейт пройден."
                ),
                max_digits=12,
            ),
        ),
        migrations.AddField(
            model_name="attendancesettings",
            name="default_sales_bonus_uzs",
            field=models.DecimalField(
                decimal_places=0,
                default=Decimal("1500000"),
                help_text=(
                    "Бонус за продажи по умолчанию (UZS). Выдаётся полностью, "
                    "если план выполнен на ≥ sales_gate; иначе 0."
                ),
                max_digits=12,
            ),
        ),
        migrations.AddField(
            model_name="attendancesettings",
            name="default_sales_gate_pct",
            field=models.PositiveSmallIntegerField(
                default=85,
                help_text=(
                    "Порог выполнения плана продаж (%%). Ниже — sales-бонус = 0."
                ),
                validators=[
                    django.core.validators.MinValueValidator(0),
                    django.core.validators.MaxValueValidator(100),
                ],
            ),
        ),
        migrations.AddField(
            model_name="attendancesettings",
            name="default_monthly_plan_uzs",
            field=models.DecimalField(
                decimal_places=0,
                default=Decimal("10000000"),
                help_text=(
                    "План продаж по умолчанию (UZS/мес). Используется как "
                    "fallback, если у оператора нет OperatorMonthlyPlan за месяц."
                ),
                max_digits=14,
            ),
        ),
    ]

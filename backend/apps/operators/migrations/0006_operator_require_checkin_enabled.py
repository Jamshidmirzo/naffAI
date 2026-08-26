# Manually authored migration — per-operator opt-in для UI check-in gate.
# Default False: существующие операторы работают как раньше, гейт
# применяется только после явного включения флага менеджером (сначала
# обкатка на demo с Test_Bonu id=51, потом массово по команде).

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("operators", "0005_operator_blocking_gate_enabled"),
    ]

    operations = [
        migrations.AddField(
            model_name="operator",
            name="require_checkin_enabled",
            field=models.BooleanField(
                default=False,
                help_text=(
                    "UI-гейт: показывать оператору блокирующий модал «Отметьтесь чтобы работать» "
                    "пока open AttendanceLog не создан. Backend API остаётся открытым. "
                    "По умолчанию OFF — включайте выборочно для обкатки."
                ),
            ),
        ),
    ]

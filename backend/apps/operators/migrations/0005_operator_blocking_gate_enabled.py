# Manually authored migration — per-operator opt-in для morning-gate.
# Default False: существующие операторы становятся «prod-безопасны»,
# гейт применяется только после явного включения флага менеджером.

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("operators", "0004_operator_personal_phone_alter_operator_phone"),
    ]

    operations = [
        migrations.AddField(
            model_name="operator",
            name="blocking_gate_enabled",
            field=models.BooleanField(
                default=False,
                help_text=(
                    "Применять блокировку RR по спец-лидам и просроченным колбэкам. "
                    "По умолчанию OFF — оператор получает новых лидов без гейта. "
                    "Включайте для тестовых операторов или после обучения."
                ),
            ),
        ),
    ]

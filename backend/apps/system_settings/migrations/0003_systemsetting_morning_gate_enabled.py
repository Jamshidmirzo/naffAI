"""
Add `morning_gate_enabled` toggle to SystemSetting.

Восстанавливает старое поведение «спец-лиды блокируют раздачу»:
пока у оператора есть просроченный/скорый callback или хотя бы один
лид в статусе с флагом `blocks_new_leads` — round-robin ему новых
лидов не выдаёт.

Раньше toggle жил в env (`MORNING_GATE_ENABLED=1`), при этом был
выключен по умолчанию. Теперь — в БД, singleton-строка pk=1,
default=True (включён), менеджер управляет из `/settings`.
"""

from django.db import migrations, models


def enable_by_default(apps, schema_editor):
    """
    Существующий singleton (pk=1) — форсим True, чтобы после
    миграции гейт сразу заработал. У новых установок default тоже
    True (см. field default).
    """
    SystemSetting = apps.get_model("system_settings", "SystemSetting")
    SystemSetting.objects.filter(pk=1).update(morning_gate_enabled=True)


def backwards(apps, schema_editor):
    # Non-destructive rollback: колонку дропнет schema-op, данные
    # трогать не надо.
    pass


class Migration(migrations.Migration):

    dependencies = [
        ("system_settings", "0002_seed_singleton"),
    ]

    operations = [
        migrations.AddField(
            model_name="systemsetting",
            name="morning_gate_enabled",
            field=models.BooleanField(
                default=True,
                help_text=(
                    "Если True — оператору не выдаются новые лиды через RR, пока у "
                    "него есть просроченный/скорый callback или хотя бы один лид в "
                    "статусе с флагом `blocks_new_leads`. Восстанавливает старое "
                    "поведение «спец-лиды блокируют раздачу»."
                ),
            ),
        ),
        migrations.RunPython(enable_by_default, backwards),
    ]

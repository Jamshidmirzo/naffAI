"""
Add `SystemSetting.morning_split_cap` — per-operator ceiling for the
morning distribution round.

Раньше `morning_distribute_leads` делил весь пул поровну без верхнего
лимита: пул 21 лид / 1 активный оператор давал 21 лид разом, что
превращало утро в «пулемёт» и заводило горловину. Теперь один оператор
получает не более `morning_split_cap` за один прогон (дефолт 5, совпадает
с `RR_BATCH_SIZE`). Остаток пула лежит неназначенным и добирается через
`refill_operator_leads` по мере закрытий.

Значение 0 → без лимита (старое поведение, для тех, кто явно захочет
вернуться).
"""

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("system_settings", "0005_retry_export_statuses"),
    ]

    operations = [
        migrations.AddField(
            model_name="systemsetting",
            name="morning_split_cap",
            field=models.PositiveSmallIntegerField(
                default=5,
                help_text=(
                    "Максимум лидов, которые один оператор получает за "
                    "утреннюю раздачу. Остальной пул остаётся "
                    "неназначенным и «доедет» через auto_refill в течение "
                    "дня. Дефолт совпадает с RR_BATCH_SIZE=5, чтобы "
                    "утренние выдачи и добивки в течение дня были одного "
                    "размера. Значение 0 → без лимита (старое поведение)."
                ),
            ),
        ),
    ]

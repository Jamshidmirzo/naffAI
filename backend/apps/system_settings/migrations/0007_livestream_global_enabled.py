from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("system_settings", "0006_systemsetting_morning_split_cap"),
    ]

    operations = [
        migrations.AddField(
            model_name="systemsetting",
            name="livestream_global_enabled",
            field=models.BooleanField(
                default=True,
                help_text=(
                    "Глобальный killswitch Live-эфира: если False — "
                    "RoomTokenApi возвращает 503, операторские publisher'ы "
                    "останавливаются в течение следующего polling-tick "
                    "(10 сек). Удобно одной кнопкой снять нагрузку SFU/"
                    "bandwidth с 40 webcam'ов сразу."
                ),
            ),
        ),
    ]

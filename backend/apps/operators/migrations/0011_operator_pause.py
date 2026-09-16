from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("operators", "0010_sip_credentials"),
    ]

    operations = [
        migrations.AddField(
            model_name="operator",
            name="is_paused",
            field=models.BooleanField(
                default=False,
                help_text=(
                    "Временно не получает новых лидов ни через один авто-канал; "
                    "уже назначенные ему лиды остаются на нём. Менеджер снимает "
                    "паузу одним кликом — оператор возвращается в раздачу."
                ),
            ),
        ),
        migrations.AddField(
            model_name="operator",
            name="paused_at",
            field=models.DateTimeField(
                null=True,
                blank=True,
                help_text="Когда оператора поставили на паузу (для аудита/отчётов).",
            ),
        ),
    ]

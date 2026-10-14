from django.db import migrations, models


class Migration(migrations.Migration):
    """
    Переключаем default `Operator.require_checkin_enabled` на True.

    Новые операторы будут по умолчанию обязаны делать чек-ин. Существующие
    строки миграция НЕ трогает (ALTER COLUMN DEFAULT не меняет данные).
    Для demo/prod rollout — отдельный SQL
    `UPDATE operators SET require_checkin_enabled=TRUE WHERE role='operator'`.
    """

    dependencies = [
        ("operators", "0016_operator_avatar"),
    ]

    operations = [
        migrations.AlterField(
            model_name="operator",
            name="require_checkin_enabled",
            field=models.BooleanField(
                default=True,
                help_text=(
                    "UI-гейт: показывать оператору блокирующий модал «Отметьтесь чтобы работать» "
                    "пока open AttendanceLog не создан. Backend API остаётся открытым. "
                    "По умолчанию ON — чек-ин обязателен для новых операторов."
                ),
            ),
        ),
    ]

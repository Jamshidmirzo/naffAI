"""
Add retry-export target fields to SystemSetting.

Менеджер вызывает `POST /leads/retry-export/` — сервис снапшотит все
лиды в статусах `sms_jonatildi` + `contacted_telegram` в отдельный tab
Google Sheet'а. Эти два поля позволяют указать target spreadsheet и
имя tab'а без правки кода. Оба необязательны: если пусто — сервис
берёт первый активный `SheetSource` (rate-limit-friendly fallback) и
имя tab'а по умолчанию «Retry SMS+TG».
"""

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("system_settings", "0003_systemsetting_morning_gate_enabled"),
    ]

    operations = [
        migrations.AddField(
            model_name="systemsetting",
            name="retry_export_spreadsheet_id",
            field=models.CharField(
                blank=True,
                default="",
                max_length=100,
                help_text=(
                    "ID Google Sheet, куда экспортируются лиды со статусами "
                    "sms_jonatildi + contacted_telegram по кнопке «Сформировать "
                    "retry-лист». Если пусто — берётся `spreadsheet_id` первого "
                    "активного SheetSource."
                ),
            ),
        ),
        migrations.AddField(
            model_name="systemsetting",
            name="retry_export_tab_name",
            field=models.CharField(
                default="Retry SMS+TG",
                max_length=100,
                help_text=(
                    "Название tab'а внутри retry-export spreadsheet'а. Создаётся "
                    "автоматически на первом экспорте; при повторном экспорте "
                    "содержимое tab'а полностью перезаписывается."
                ),
            ),
        ),
    ]

"""
Add `SystemSetting.retry_export_statuses` (JSONField list of LeadStatusLabel codes).

Раньше список retry-статусов был захардкожен в `apps.leads.selectors`
(RETRY_EXPORT_STATUSES = 4 значения). Теперь менеджер выбирает набор
через UI (/leads-stats → «Retry статусы»).

Дефолт `[]` — пустой список, селектор в этом случае использует
`DEFAULT_RETRY_EXPORT_STATUSES` (backwards-compat: те же 4 кода).
"""

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("system_settings", "0004_retry_export_target"),
    ]

    operations = [
        migrations.AddField(
            model_name="systemsetting",
            name="retry_export_statuses",
            field=models.JSONField(
                default=list,
                blank=True,
                help_text=(
                    "Список code'ов LeadStatusLabel для retry-export'а. "
                    "Пустой список → используется дефолт (sms_jonatildi, "
                    "contacted_telegram, no_answer, no_answer_2). "
                    "Меняется через /api/settings/retry-export/."
                ),
            ),
        ),
    ]

"""
ТЕЗ-лиды (hot leads) с 10-минутным SLA.

Добавляет на SheetSource флаг «горячий шит» (`is_hot`) и настраиваемое
время SLA в минутах (`hot_sla_minutes`, default 10, диапазон 1..120).
На Lead — поле `hot_until` (nullable timestamp): дедлайн первого контакта,
взводится при импорте строки из горячего шита, обнуляется при любом
изменении статуса (lead_update_status). Watcher
`hot_leads_escalation` ищет лиды с просроченным hot_until и
уведомляет владельца единым TG-сообщением.

Миграция чисто аддитивная (nullable + default). Безопасна для
онлайн-применения, никакие существующие лиды не затрагиваются.
"""

from django.core.validators import MaxValueValidator, MinValueValidator
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("leads", "0026_dead_end_terminal_statuses"),
    ]

    operations = [
        migrations.AddField(
            model_name="sheetsource",
            name="is_hot",
            field=models.BooleanField(
                default=False,
                help_text=(
                    "Горячий шит (ТЕЗ): новые лиды помечаются hot_until "
                    "при импорте."
                ),
            ),
        ),
        migrations.AddField(
            model_name="sheetsource",
            name="hot_sla_minutes",
            field=models.PositiveSmallIntegerField(
                default=10,
                validators=[MinValueValidator(1), MaxValueValidator(120)],
                help_text=(
                    "Сколько минут у оператора на первый контакт с горячим "
                    "лидом. По истечении лид считается остывшим — watcher "
                    "уведомит владельца."
                ),
            ),
        ),
        migrations.AddField(
            model_name="lead",
            name="hot_until",
            field=models.DateTimeField(
                null=True,
                blank=True,
                db_index=True,
                help_text=(
                    "Дедлайн первого контакта для горячих лидов (ТЕЗ). "
                    "NULL = не горячий, уже обработан, или уже остыл + "
                    "эскалирован."
                ),
            ),
        ),
    ]

import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('leads', '0003_lead_postpone'),
        ('operators', '0003_operator_daily_lesson_opt_out'),
    ]

    operations = [
        migrations.AddField(
            model_name='sheetsource',
            name='default_operator',
            field=models.ForeignKey(
                blank=True,
                help_text=(
                    "Used by `alias_or_default` / `default_only` distribution modes "
                    "when the row alias didn't resolve to a bound operator."
                ),
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name='default_for_sheets',
                to='operators.operator',
            ),
        ),
        migrations.AddField(
            model_name='sheetsource',
            name='distribution_mode',
            field=models.CharField(
                choices=[
                    ('alias_only', 'Только по alias (иначе needs_review)'),
                    ('alias_or_default', 'По alias, иначе default оператор'),
                    ('default_only', 'Всегда default (игнорировать alias)'),
                    ('alias_or_rr', 'По alias, иначе round-robin'),
                ],
                default='alias_only',
                help_text=(
                    "Fallback routing rule when the row alias is missing or unknown. "
                    "Preserves the historical 'alias_only' behaviour by default."
                ),
                max_length=32,
            ),
        ),
    ]

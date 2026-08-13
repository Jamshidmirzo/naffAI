"""
Loosen PROTECT → SET_NULL on CallAttempt.operator and
CallbackReminder.operator so hard-deleting an operator preserves the
historical call/callback trail (row survives, operator FK becomes NULL,
UI shows "Удалённый оператор").
"""

import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("calls", "0002_initial"),
        ("operators", "0004_operator_personal_phone_alter_operator_phone"),
    ]

    operations = [
        migrations.AlterField(
            model_name="callattempt",
            name="operator",
            field=models.ForeignKey(
                blank=True,
                help_text=(
                    "NULL means the operator who made this call has since"
                    " been deleted. Row is kept so lead history stays intact."
                ),
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="call_attempts",
                to="operators.operator",
            ),
        ),
        migrations.AlterField(
            model_name="callbackreminder",
            name="operator",
            field=models.ForeignKey(
                blank=True,
                help_text=(
                    "NULL means the assigned operator has since been deleted."
                    " The reminder is kept for history but won't DM anyone."
                ),
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="callback_reminders",
                to="operators.operator",
            ),
        ),
    ]

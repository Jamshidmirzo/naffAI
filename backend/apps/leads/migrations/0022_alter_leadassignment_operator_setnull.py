"""
Loosen PROTECT → SET_NULL on LeadAssignment.operator so hard-deleting an
operator preserves the lead-movement audit trail (row survives, operator
FK becomes NULL, UI shows "Удалённый оператор" for that assignment).
"""

import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("leads", "0021_restore_working_statuses_active"),
        ("operators", "0004_operator_personal_phone_alter_operator_phone"),
    ]

    operations = [
        migrations.AlterField(
            model_name="leadassignment",
            name="operator",
            field=models.ForeignKey(
                blank=True,
                help_text=(
                    "NULL means the operator this row assigned to has since"
                    " been deleted. Row is preserved for lead-movement audit."
                ),
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="lead_assignments",
                to="operators.operator",
            ),
        ),
    ]

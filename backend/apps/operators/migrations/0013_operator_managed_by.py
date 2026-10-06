# Generated manually 2026-10-06 — ownership FK for 3-level hierarchy
# (super_manager → manager → operator). Node of the «sorted-herding-pike» plan.
#
# Change:
#   * add nullable Operator.managed_by FK → auth.User (SET_NULL, related_name
#     "managed_operators").
# Nullable, no data migration — existing operators remain «unassigned» until
# a manager/super_manager explicitly claims them through the UI.

from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        ("operators", "0012_operator_day_off"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.AddField(
            model_name="operator",
            name="managed_by",
            field=models.ForeignKey(
                blank=True,
                help_text=(
                    "Manager или super_manager, который напрямую владеет этим "
                    "оператором. NULL = legacy «общий пул», виден всем менеджерам."
                ),
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="managed_operators",
                to=settings.AUTH_USER_MODEL,
            ),
        ),
    ]

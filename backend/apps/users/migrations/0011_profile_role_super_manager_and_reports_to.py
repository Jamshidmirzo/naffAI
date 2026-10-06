# Generated manually 2026-10-06 — 3-level hierarchy (super_manager role +
# Profile.reports_to FK). Node of the «sorted-herding-pike» plan.
#
# Changes:
#   * extend Role choices to include super_manager (ordered before SUPERADMIN);
#   * add nullable Profile.reports_to FK → auth.User (SET_NULL, related_name
#     "direct_reports").
# Both operations are safe for prod — nullable field, choices-only change,
# no data migration.

from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        ("users", "0010_alter_profile_role"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.AlterField(
            model_name="profile",
            name="role",
            field=models.CharField(
                choices=[
                    ("team_lead", "Тимлид"),
                    ("manager", "Менеджер"),
                    ("super_manager", "Супер-менеджер"),
                    ("operator", "Оператор"),
                    ("smm", "SMM"),
                    ("superadmin", "Супер-админ"),
                ],
                default="team_lead",
                max_length=16,
            ),
        ),
        migrations.AddField(
            model_name="profile",
            name="reports_to",
            field=models.ForeignKey(
                blank=True,
                help_text=(
                    "Для role=manager → super_manager owner. Для super_manager → "
                    "owner (superadmin). NULL для прочих ролей или legacy-профилей."
                ),
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="direct_reports",
                to=settings.AUTH_USER_MODEL,
            ),
        ),
    ]

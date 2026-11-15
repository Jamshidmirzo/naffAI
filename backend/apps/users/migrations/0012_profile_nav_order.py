from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("users", "0011_profile_role_super_manager_and_reports_to"),
    ]

    operations = [
        migrations.AddField(
            model_name="profile",
            name="nav_order",
            field=models.JSONField(blank=True, default=list),
        ),
    ]

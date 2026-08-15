from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("users", "0006_profile_role_superadmin"),
    ]

    operations = [
        migrations.AddField(
            model_name="profile",
            name="attendance_pin_hash",
            field=models.CharField(
                blank=True,
                default="",
                help_text=(
                    "Django password-hash 4-значного PIN'a. "
                    "Пусто = PIN не задан."
                ),
                max_length=128,
            ),
        ),
    ]

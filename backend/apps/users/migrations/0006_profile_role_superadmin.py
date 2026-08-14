from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("users", "0005_profile_tg_link_code"),
    ]

    operations = [
        migrations.AlterField(
            model_name="profile",
            name="role",
            field=models.CharField(
                choices=[
                    ("team_lead", "Тимлид"),
                    ("manager", "Менеджер"),
                    ("operator", "Оператор"),
                    ("superadmin", "Супер-админ"),
                ],
                default="team_lead",
                max_length=16,
            ),
        ),
    ]

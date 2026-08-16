from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("users", "0008_remove_profile_attendance_pin_hash"),
    ]

    operations = [
        migrations.AddField(
            model_name="profile",
            name="preferred_language",
            field=models.CharField(
                choices=[("ru", "Русский"), ("uz", "O'zbekcha")],
                default="uz",
                help_text=(
                    "Основной язык интерфейса и AI-контента (утренние "
                    "цитаты, дневные уроки). Default 'uz' т.к. большинство "
                    "операторов — узбекско-говорящие. Manager/superadmin "
                    "может переключить конкретному оператору на 'ru'."
                ),
                max_length=8,
            ),
        ),
    ]

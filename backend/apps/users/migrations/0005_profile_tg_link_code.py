from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("users", "0004_operatorsecret_key_version"),
    ]

    operations = [
        migrations.AddField(
            model_name="profile",
            name="tg_link_code",
            field=models.CharField(blank=True, db_index=True, default="", max_length=8),
        ),
        migrations.AddField(
            model_name="profile",
            name="tg_link_code_expires_at",
            field=models.DateTimeField(blank=True, null=True),
        ),
    ]

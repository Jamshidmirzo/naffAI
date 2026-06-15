from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("sales", "0003_backfill_lines")]

    operations = [
        migrations.AddField(
            model_name="sale",
            name="client_name",
            field=models.CharField(blank=True, default="", max_length=128),
        ),
        migrations.AddField(
            model_name="sale",
            name="client_phone",
            field=models.CharField(blank=True, default="", max_length=32),
        ),
    ]

from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("operators", "0015_livestream_default_true"),
    ]

    operations = [
        migrations.AddField(
            model_name="operator",
            name="paused_reason",
            field=models.CharField(
                blank=True,
                default="",
                help_text=(
                    "Why paused: manual (manager — survives check-in), checkout / "
                    "auto_close (end of shift — lifted by the next check-in), day_off. "
                    "Empty = legacy pause, treated like checkout."
                ),
                max_length=16,
            ),
        ),
    ]

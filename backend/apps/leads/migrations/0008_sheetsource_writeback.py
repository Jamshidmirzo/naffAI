from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("leads", "0007_seed_builtin_statuses"),
    ]

    operations = [
        migrations.AddField(
            model_name="sheetsource",
            name="writeback_columns",
            field=models.JSONField(
                blank=True,
                default=dict,
                help_text=(
                    "Writeback layout: {'enabled': true, 'status_col': 'D', "
                    "'operator_col': 'E', 'updated_col': 'F', 'comment_col': 'G'}. "
                    "Missing keys fall back to the defaults."
                ),
            ),
        ),
    ]

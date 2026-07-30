from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("leads", "0010_qimmatlik_and_retry"),
    ]

    operations = [
        migrations.AlterField(
            model_name="leadassignment",
            name="source",
            field=models.CharField(
                choices=[
                    ("sheet_manual", "Из таблицы (alias)"),
                    ("auto_round_robin", "Автоматически (RR)"),
                    ("admin_reassign", "Переназначение админом"),
                    ("qimmatlik_retry", "Retry после qimmatlik"),
                ],
                default="auto_round_robin",
                max_length=32,
            ),
        ),
    ]

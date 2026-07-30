from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("leads", "0011_alter_leadassignment_source"),
    ]

    operations = [
        migrations.AddField(
            model_name="lead",
            name="phone_alt",
            field=models.CharField(
                blank=True,
                default="",
                help_text=(
                    "Second normalized +998 number if the sheet row "
                    "carries two."
                ),
                max_length=16,
            ),
        ),
    ]

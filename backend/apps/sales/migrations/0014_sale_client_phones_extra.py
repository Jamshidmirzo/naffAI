from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("sales", "0013_sale_sale_status_sold_at_idx_and_more"),
    ]

    operations = [
        migrations.AddField(
            model_name="sale",
            name="client_phones_extra",
            field=models.JSONField(
                blank=True,
                default=list,
                help_text=(
                    "Additional client phones beyond `client_phone` "
                    "(kept as primary for sheets/search backwards compat)."
                ),
            ),
        ),
    ]

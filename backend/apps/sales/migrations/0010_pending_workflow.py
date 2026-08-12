"""
Add contract_photo + rejection_reason + rejected_at fields to Sale so
operators can submit pending sales with an attached contract photo and
managers can reject with a reason. Also register REJECTED as a valid
SaleStatus choice.

Introduced for demo.naff.flek.uz playground; new fields are all nullable
so they don't break the existing prod frontend which knows nothing about
them.
"""

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("sales", "0009_sale_sheet_source_bonus"),
    ]

    operations = [
        migrations.AddField(
            model_name="sale",
            name="contract_photo",
            field=models.ImageField(
                blank=True,
                help_text="Фото договора, приложенное оператором при создании pending-продажи.",
                null=True,
                upload_to="sales/contracts/%Y/%m/",
            ),
        ),
        migrations.AddField(
            model_name="sale",
            name="rejection_reason",
            field=models.TextField(blank=True, default=""),
        ),
        migrations.AddField(
            model_name="sale",
            name="rejected_at",
            field=models.DateTimeField(blank=True, null=True),
        ),
        migrations.AlterField(
            model_name="sale",
            name="status",
            field=models.CharField(
                choices=[
                    ("pending", "На подтверждении"),
                    ("confirmed", "Подтверждена"),
                    ("rejected", "Отклонена"),
                ],
                default="confirmed",
                max_length=16,
            ),
        ),
    ]

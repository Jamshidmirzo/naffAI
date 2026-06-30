from decimal import Decimal

from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("sales", "0004_sale_client_name_client_phone")]

    operations = [
        migrations.AddField(
            model_name="sale",
            name="discount",
            field=models.DecimalField(
                decimal_places=2,
                default=Decimal("0"),
                help_text=(
                    "Скидка на эту продажу в UZS. Уменьшает кредит операторов "
                    "пропорционально их долям (Σ SaleOperator.amount = amount − discount)."
                ),
                max_digits=14,
            ),
        ),
    ]

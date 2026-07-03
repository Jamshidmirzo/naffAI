from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        ("operators", "0002_operatormonthlyplan"),
        ("sales", "0006_sale_quantity"),
    ]

    operations = [
        # Sale.operator — allow NULL so soft-deleted sales don't block operator hard-delete
        migrations.AlterField(
            model_name="sale",
            name="operator",
            field=models.ForeignKey(
                "operators.Operator",
                null=True,
                blank=True,
                on_delete=django.db.models.deletion.PROTECT,
                related_name="sales",
            ),
        ),
        # SaleOperator.operator — same
        migrations.AlterField(
            model_name="saleoperator",
            name="operator",
            field=models.ForeignKey(
                "operators.Operator",
                null=True,
                blank=True,
                on_delete=django.db.models.deletion.PROTECT,
                related_name="operator_lines",
            ),
        ),
    ]

from django.db import migrations


def forwards(apps, schema_editor):
    Sale = apps.get_model("sales", "Sale")
    SaleOperator = apps.get_model("sales", "SaleOperator")
    SalePartner = apps.get_model("sales", "SalePartner")
    for sale in Sale.objects.all().only("id", "operator_id", "channel_id", "amount"):
        if sale.operator_id and not SaleOperator.objects.filter(sale_id=sale.id).exists():
            SaleOperator.objects.create(
                sale_id=sale.id, operator_id=sale.operator_id, amount=sale.amount
            )
        if sale.channel_id and not SalePartner.objects.filter(sale_id=sale.id).exists():
            SalePartner.objects.create(
                sale_id=sale.id, partner_id=sale.channel_id, amount=sale.amount
            )


def backwards(apps, schema_editor):
    apps.get_model("sales", "SaleOperator").objects.all().delete()
    apps.get_model("sales", "SalePartner").objects.all().delete()


class Migration(migrations.Migration):
    dependencies = [("sales", "0002_saleoperator_salepartner")]
    operations = [migrations.RunPython(forwards, backwards)]

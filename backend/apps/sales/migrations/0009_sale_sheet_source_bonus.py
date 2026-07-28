import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('sales', '0008_sale_lead_alter_saleoperator_operator'),
        ('leads', '0004_sheetsource_distribution'),
    ]

    operations = [
        migrations.AddField(
            model_name='sale',
            name='sheet_source',
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name='sales',
                to='leads.sheetsource',
            ),
        ),
        migrations.AddField(
            model_name='sale',
            name='bonus_note',
            field=models.TextField(blank=True, default=''),
        ),
    ]

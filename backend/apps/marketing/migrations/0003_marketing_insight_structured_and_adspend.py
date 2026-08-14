# Generated for the Marketing module redesign.
# - MarketingInsight gets structured_output / actions_taken / dashboard_payload_snapshot.
# - AdSpend model for CAC/ROI calculation per source per period.

from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('marketing', '0002_marketinginsight_provider_used'),
        ('leads', '0001_initial'),  # AdSpend.source FK to leads.SheetSource
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.AddField(
            model_name='marketinginsight',
            name='structured_output',
            field=models.JSONField(blank=True, default=dict),
        ),
        migrations.AddField(
            model_name='marketinginsight',
            name='actions_taken',
            field=models.JSONField(blank=True, default=list),
        ),
        migrations.AddField(
            model_name='marketinginsight',
            name='dashboard_payload_snapshot',
            field=models.JSONField(blank=True, default=dict),
        ),
        migrations.CreateModel(
            name='AdSpend',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('period_start', models.DateField()),
                ('period_end', models.DateField()),
                ('source_label', models.CharField(blank=True, default='', help_text='For BOT / MANUAL / custom acquisition channels not modelled as SheetSource.', max_length=128)),
                ('amount', models.DecimalField(decimal_places=2, max_digits=14)),
                ('currency', models.CharField(default='UZS', max_length=8)),
                ('note', models.TextField(blank=True, default='')),
                ('created_by', models.ForeignKey(blank=True, null=True, on_delete=models.deletion.SET_NULL, related_name='+', to=settings.AUTH_USER_MODEL)),
                ('source', models.ForeignKey(blank=True, help_text='If bound to a sheet source, use FK. Otherwise leave null and set source_label.', null=True, on_delete=models.deletion.SET_NULL, related_name='ad_spend_rows', to='leads.sheetsource')),
            ],
            options={
                'ordering': ['-period_start', '-id'],
                'indexes': [
                    models.Index(fields=['period_start', 'period_end'], name='marketing_a_period__69b197_idx'),
                    models.Index(fields=['source', 'period_start'], name='marketing_a_source__1d15a5_idx'),
                ],
            },
        ),
    ]

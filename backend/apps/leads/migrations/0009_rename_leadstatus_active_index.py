from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ("leads", "0008_sheetsource_writeback"),
    ]

    operations = [
        migrations.RenameIndex(
            model_name="leadstatuslabel",
            new_name="leads_leads_is_acti_8e9e34_idx",
            old_name="leadstatus_active_order_idx",
        ),
    ]

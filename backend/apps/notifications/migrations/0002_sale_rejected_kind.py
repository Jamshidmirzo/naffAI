"""Add SALE_REJECTED to NotificationKind choices."""

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("notifications", "0001_initial"),
    ]

    operations = [
        migrations.AlterField(
            model_name="notification",
            name="kind",
            field=models.CharField(
                choices=[
                    ("sale_created", "Новая продажа"),
                    ("sale_returned", "Возврат продажи"),
                    ("sale_rejected", "Продажа отклонена"),
                    ("callback_overdue", "Просроченный колбэк"),
                    ("lead_assigned", "Новый лид"),
                    ("system", "Системное сообщение"),
                ],
                db_index=True,
                max_length=32,
            ),
        ),
    ]

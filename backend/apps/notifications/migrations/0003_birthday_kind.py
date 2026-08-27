"""Add BIRTHDAY to NotificationKind choices (2026-08-27)."""

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("notifications", "0002_sale_rejected_kind"),
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
                    ("birthday", "День рождения оператора"),
                    ("system", "Системное сообщение"),
                ],
                db_index=True,
                max_length=32,
            ),
        ),
    ]

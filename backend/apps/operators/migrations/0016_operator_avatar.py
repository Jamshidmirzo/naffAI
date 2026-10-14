"""
Operator.avatar + avatar_updated_at.

Один актуальный снимок на оператора (upload / webcam / snapshot-request).
Старый файл перезаписывается — историю не ведём.
"""

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("operators", "0015_livestream_default_true"),
    ]

    operations = [
        migrations.AddField(
            model_name="operator",
            name="avatar",
            field=models.ImageField(
                blank=True,
                null=True,
                upload_to="operators/avatars/",
                help_text="Актуальный снимок оператора (file / webcam / snapshot).",
            ),
        ),
        migrations.AddField(
            model_name="operator",
            name="avatar_updated_at",
            field=models.DateTimeField(
                blank=True,
                null=True,
                help_text="Когда последний раз обновлялся avatar.",
            ),
        ),
    ]

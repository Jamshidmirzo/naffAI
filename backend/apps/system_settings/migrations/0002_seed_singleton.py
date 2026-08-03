"""
Seed the singleton row (pk=1) so `SystemSetting.get_solo()` never has
to create it lazily under contention (e.g. two concurrent morning-split
runs both racing to INSERT the same pk).
"""

from django.db import migrations


def forwards(apps, schema_editor):
    SystemSetting = apps.get_model("system_settings", "SystemSetting")
    SystemSetting.objects.get_or_create(pk=1, defaults={"auto_distribution_enabled": True})


def backwards(apps, schema_editor):
    # Non-destructive: keep the row on rollback.
    pass


class Migration(migrations.Migration):

    dependencies = [
        ("system_settings", "0001_initial"),
    ]

    operations = [
        migrations.RunPython(forwards, backwards),
    ]

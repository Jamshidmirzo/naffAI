"""
Add builtin `qimmatlik_qildi` status + restore the `new` row that the
manager had renamed to «Qimatlik Qildi» before the dedicated code
existed.

No schema change — this is purely a data migration.
"""

from django.db import migrations


def upgrade(apps, schema_editor):
    LeadStatusLabel = apps.get_model("leads", "LeadStatusLabel")

    LeadStatusLabel.objects.update_or_create(
        code="qimmatlik_qildi",
        defaults={
            "emoji": "💸",
            "tone": "hot",
            "sort_order": 55,
            "show_in_chip": True,
            "show_in_button": True,
            "label_ru": "Показалось дорого",
            "label_uz": "Qimmatlik qildi",
            "is_active": True,
            "is_builtin": True,
        },
    )

    # The manager repurposed `new` as a stand-in for the missing
    # qimmatlik code — restore the original text now that we have the
    # dedicated one.
    LeadStatusLabel.objects.filter(code="new").update(
        label_ru="Новый",
        label_uz="Yangi",
        tone="info",
        emoji="📋",
    )


def downgrade(apps, schema_editor):
    LeadStatusLabel = apps.get_model("leads", "LeadStatusLabel")
    LeadStatusLabel.objects.filter(code="qimmatlik_qildi").delete()


class Migration(migrations.Migration):

    dependencies = [
        ("leads", "0009_rename_leadstatus_active_index"),
    ]

    operations = [
        migrations.RunPython(upgrade, downgrade),
    ]

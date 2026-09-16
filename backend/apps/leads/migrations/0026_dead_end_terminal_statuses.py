from django.db import migrations


DEAD_END_CODES = [
    "boshqa_joydan_xarid_qilgan",
    "notogri_raqam",
    "ishonchdan_olgan",
    "shunchaki_qiziqdi",
]


def mark_terminal(apps, schema_editor):
    Label = apps.get_model("leads", "LeadStatusLabel")
    Label.objects.filter(code__in=DEAD_END_CODES).update(is_terminal=True)


def unmark_terminal(apps, schema_editor):
    Label = apps.get_model("leads", "LeadStatusLabel")
    Label.objects.filter(code__in=DEAD_END_CODES).update(is_terminal=False)


class Migration(migrations.Migration):
    dependencies = [
        ("leads", "0025_sheetsource_allowed_operators"),
    ]

    operations = [
        migrations.RunPython(mark_terminal, unmark_terminal),
    ]

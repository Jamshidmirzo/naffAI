"""
Restore working statuses (contacted_telegram, qimmatlik_qildi, waiting_salary,
has_debt, kartsi_yoq, harid_qildi, shunchaki_qiziqdi, notogri_raqam, sms_jonatildi)
from terminal back to active (is_terminal=False) so that all historical/old leads
in these statuses are returned to the operator's active tab ("Faol").
"""

from django.db import migrations

REAL_TERMINAL = {"won", "lost", "archived", "needs_review"}

WORKING_STATUSES = {
    "new",
    "assigned",
    "in_progress",
    "callback_scheduled",
    "contacted_telegram",
    "no_answer",
    "no_answer_2",
    "phone_on",
    "dokonga_keladi",
    "qimmatlik_qildi",
    "waiting_salary",
    "has_debt",
    "kartsi_yoq",
    "harid_qildi",
    "shunchaki_qiziqdi",
    "notogri_raqam",
    "sms_jonatildi",
}


def upgrade(apps, schema_editor):
    LeadStatusLabel = apps.get_model("leads", "LeadStatusLabel")

    # True terminal statuses stay terminal
    LeadStatusLabel.objects.filter(code__in=REAL_TERMINAL).update(
        is_terminal=True,
    )

    # All working statuses are non-terminal (active)
    LeadStatusLabel.objects.filter(code__in=WORKING_STATUSES).update(
        is_terminal=False,
    )


def revert(apps, schema_editor):
    pass


class Migration(migrations.Migration):

    dependencies = [
        ("leads", "0020_seed_recall_after_lunch"),
    ]

    operations = [
        migrations.RunPython(upgrade, revert),
    ]

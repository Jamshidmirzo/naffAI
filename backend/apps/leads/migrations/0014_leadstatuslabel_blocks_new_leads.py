"""
Add `blocks_new_leads` toggle to LeadStatusLabel + preseed the
statuses that count as «needs closure» — they used to be hard-coded
in selectors.py as "yesterday_backlog"; now the manager can toggle
which ones block RR intake directly from /statuses.
"""

from django.db import migrations, models


# codes that were previously blocking via the yesterday_backlog heuristic
DEFAULT_BLOCKING = (
    "callback_scheduled",
    "no_answer",
    "no_answer_2",
    "phone_on",
    "has_debt",
)


def preseed(apps, schema_editor):
    LeadStatusLabel = apps.get_model("leads", "LeadStatusLabel")
    LeadStatusLabel.objects.filter(code__in=DEFAULT_BLOCKING).update(
        blocks_new_leads=True
    )


def revert(apps, schema_editor):
    LeadStatusLabel = apps.get_model("leads", "LeadStatusLabel")
    LeadStatusLabel.objects.all().update(blocks_new_leads=False)


class Migration(migrations.Migration):

    dependencies = [
        ("leads", "0013_restore_builtin_labels"),
    ]

    operations = [
        migrations.AddField(
            model_name="leadstatuslabel",
            name="blocks_new_leads",
            field=models.BooleanField(
                default=False,
                help_text=(
                    "If true, an operator holding at least one lead in "
                    "this status is skipped by round-robin — they must "
                    "resolve it (mark won/lost/archived or move to a "
                    "non-blocking status) before RR hands them a fresh "
                    "number."
                ),
            ),
        ),
        migrations.RunPython(preseed, revert),
    ]

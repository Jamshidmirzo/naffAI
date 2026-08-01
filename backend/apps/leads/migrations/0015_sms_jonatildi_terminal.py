"""
Codify the terminal/working split explicitly on LeadStatusLabel:
- New `is_terminal` flag (closed leads — kartsi_yoq, qarzi_bor, harid_qildi …)
- New builtin `sms_jonatildi` for the «двух неответов подряд → закрыл SMS'кой».
- Sanitize `blocks_new_leads`: OFF for every terminal, ON only for the
  four working buckets (javob_bermadi_1/2, phone_on, dokonga_keladi) +
  callback_scheduled.
"""

from django.db import migrations, models


TERMINAL = {
    "qarzi_bor",
    "kartsi_yoq",
    "waiting_salary",   # limit chiqmadi
    "harid_qildi",
    "notogri_raqam",
    "lost",
    "needs_review",
    "sms_jonatildi",
    "won",
    "archived",
    "qimmatlik_qildi",  # after retry chain, treated as closed for this operator
    "contacted_telegram",  # TG handoff — operator done for now
}
WORKING_BLOCKERS = {
    "no_answer",
    "no_answer_2",
    "phone_on",
    "dokonga_keladi",
    "callback_scheduled",
}


def upgrade(apps, schema_editor):
    LeadStatusLabel = apps.get_model("leads", "LeadStatusLabel")

    # Ensure sms_jonatildi exists (create if missing, refresh label/tone).
    LeadStatusLabel.objects.update_or_create(
        code="sms_jonatildi",
        defaults={
            "label_ru": "SMS отправлен",
            "label_uz": "SMS jonatildi",
            "tone": "neutral",
            "emoji": "💬",
            "sort_order": 115,
            "show_in_chip": True,
            "show_in_button": True,
            "is_active": True,
            "is_builtin": True,
        },
    )

    # Tag all terminals + strip blocker flag from them.
    LeadStatusLabel.objects.filter(code__in=TERMINAL).update(
        is_terminal=True, blocks_new_leads=False,
    )
    # Explicit non-terminal for working buckets (defensive).
    LeadStatusLabel.objects.filter(code__in=WORKING_BLOCKERS).update(
        is_terminal=False, blocks_new_leads=True,
    )


def revert(apps, schema_editor):
    LeadStatusLabel = apps.get_model("leads", "LeadStatusLabel")
    LeadStatusLabel.objects.update(is_terminal=False)


class Migration(migrations.Migration):

    dependencies = [
        ("leads", "0014_leadstatuslabel_blocks_new_leads"),
    ]

    operations = [
        migrations.AddField(
            model_name="leadstatuslabel",
            name="is_terminal",
            field=models.BooleanField(
                default=False,
                help_text=(
                    "Terminal / «закрытый» status: the lead is done, "
                    "operator doesn't work it anymore. Terminal leads "
                    "don't count toward the RR batch quota, don't block "
                    "new-lead intake, and are excluded from the /my "
                    "active tab by default."
                ),
            ),
        ),
        migrations.RunPython(upgrade, revert),
    ]

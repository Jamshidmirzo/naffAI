"""
Seed `recall_after_lunch=True` для no_answer и phone_on.

Правило: если оператор до обеда пометил лид как «Javob bermadi 1» или
«Telfoni ochiq» — после 13:00 Asia/Tashkent этот лид снова должен всплыть
в /my active и попасть в счётчик working, чтобы оператор попробовал ещё
раз в тот же день. Если повторно no_answer после обеда — лид уходит на
завтра как обычный carry (carry_over_next_day уже стоит).
"""

from django.db import migrations


RECALL_AFTER_LUNCH_DEFAULTS = ("no_answer", "phone_on")


def upgrade(apps, schema_editor):
    LeadStatusLabel = apps.get_model("leads", "LeadStatusLabel")
    LeadStatusLabel.objects.filter(code__in=RECALL_AFTER_LUNCH_DEFAULTS).update(
        recall_after_lunch=True
    )


def revert(apps, schema_editor):
    LeadStatusLabel = apps.get_model("leads", "LeadStatusLabel")
    LeadStatusLabel.objects.filter(code__in=RECALL_AFTER_LUNCH_DEFAULTS).update(
        recall_after_lunch=False
    )


class Migration(migrations.Migration):

    dependencies = [
        ("leads", "0019_leadstatuslabel_recall_after_lunch"),
    ]

    operations = [
        migrations.RunPython(upgrade, revert),
    ]

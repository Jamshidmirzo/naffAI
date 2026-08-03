"""
Seed `carry_over_next_day=True` on the «спец-статусы» пула — лидов, которые
оператор ещё не закрыл, но и не в терминале: их нужно добить, поэтому на
следующее утро они всплывают в /my active раньше свежих.

`has_debt` намеренно НЕ включён — там ждём зарплаты / нет решения от
клиента, и держать такие лиды первыми весь месяц бессмысленно.
"""

from django.db import migrations


CARRY_OVER_DEFAULTS = (
    "no_answer",
    "no_answer_2",
    "phone_on",
    "callback_scheduled",
    "contacted_telegram",
)


def upgrade(apps, schema_editor):
    LeadStatusLabel = apps.get_model("leads", "LeadStatusLabel")
    LeadStatusLabel.objects.filter(code__in=CARRY_OVER_DEFAULTS).update(
        carry_over_next_day=True
    )


def revert(apps, schema_editor):
    LeadStatusLabel = apps.get_model("leads", "LeadStatusLabel")
    LeadStatusLabel.objects.filter(code__in=CARRY_OVER_DEFAULTS).update(
        carry_over_next_day=False
    )


class Migration(migrations.Migration):

    dependencies = [
        ("leads", "0016_leadstatuslabel_carry_over_next_day_and_more"),
    ]

    operations = [
        migrations.RunPython(upgrade, revert),
    ]

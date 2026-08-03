"""
Пометить `dokonga_keladi` как carry_over_next_day, чтобы этот статус вел
себя так же, как no_answer / phone_on / callback_scheduled: сегодня-
обработанный лид пропадает из /my active (правило «оператор сегодня уже
тронул»), но завтра снова всплывает первым в сортировке carry-групп.

Причина: клиент по факту «догоняем завтра» — держать лид первыми весь
день не имеет смысла, а вот утром — обязательно.
"""

from django.db import migrations


CARRY_OVER_ADDED = ("dokonga_keladi",)


def upgrade(apps, schema_editor):
    LeadStatusLabel = apps.get_model("leads", "LeadStatusLabel")
    LeadStatusLabel.objects.filter(code__in=CARRY_OVER_ADDED).update(
        carry_over_next_day=True
    )


def revert(apps, schema_editor):
    LeadStatusLabel = apps.get_model("leads", "LeadStatusLabel")
    LeadStatusLabel.objects.filter(code__in=CARRY_OVER_ADDED).update(
        carry_over_next_day=False
    )


class Migration(migrations.Migration):

    dependencies = [
        ("leads", "0017_seed_carry_over_defaults"),
    ]

    operations = [
        migrations.RunPython(upgrade, revert),
    ]

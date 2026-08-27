# Manually authored migration — birth_date + birthday_notified_on.
# Both NULL по умолчанию → нулевые side-effects на prod: пока никто не
# заполнит дату, cron ничего не шлёт, UI ничего не показывает.
# `birthday_notified_on` — idempotency guard для cron `birthday_notify`.

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("operators", "0006_operator_require_checkin_enabled"),
    ]

    operations = [
        migrations.AddField(
            model_name="operator",
            name="birth_date",
            field=models.DateField(
                null=True,
                blank=True,
                help_text=(
                    "Дата рождения оператора (ДД.ММ.ГГГГ). Год виден только "
                    "менеджерам в карточке; в остальном UI — только день и месяц."
                ),
            ),
        ),
        migrations.AddField(
            model_name="operator",
            name="birthday_notified_on",
            field=models.DateField(
                null=True,
                blank=True,
                help_text=(
                    "Idempotency: дата, за которую уже разослали поздравление "
                    "менеджерам. Пустое → cron ещё не отправлял в этом году. "
                    "Guards от дублей при рестарте / ручном повторном запуске."
                ),
            ),
        ),
    ]

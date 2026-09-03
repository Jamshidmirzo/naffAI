"""
Enforcement + notification flags (2026-09-03).

Три изменения:
  1. `AttendanceSettings.enforce_daily_checkin` (default True) — глобальный
     UI-гейт «Отметьтесь чтобы работать» для всех операторов.
  2. `AttendanceSettings.nine_hour_reminder_hours` (default 9) — после
     скольких часов слать «пора закрыть смену».
  3. `AttendanceLog.late_notified_at` + `nine_hour_notified_at` —
     idempotency guards для двух cron-уведомлений.
"""

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("attendance", "0009_two_gate_payroll"),
    ]

    operations = [
        migrations.AddField(
            model_name="attendancesettings",
            name="enforce_daily_checkin",
            field=models.BooleanField(
                default=True,
                help_text=(
                    "Глобальный UI-гейт: если True — оператору без открытого "
                    "AttendanceLog показывается блокирующий модал «Сначала "
                    "отметьтесь». Backend endpoints остаются открытыми (гейт "
                    "только на UI). Выключить можно, если ломается."
                ),
            ),
        ),
        migrations.AddField(
            model_name="attendancesettings",
            name="nine_hour_reminder_hours",
            field=models.PositiveSmallIntegerField(
                default=9,
                help_text=(
                    "После скольких часов от check-in слать оператору «пора "
                    "закрыть смену» in-app уведомление (одно за смену)."
                ),
            ),
        ),
        migrations.AddField(
            model_name="attendancelog",
            name="late_notified_at",
            field=models.DateTimeField(
                null=True,
                blank=True,
                help_text=(
                    "Момент отправки уведомления об опоздании оператору. "
                    "Установлен → не слать повторно."
                ),
            ),
        ),
        migrations.AddField(
            model_name="attendancelog",
            name="nine_hour_notified_at",
            field=models.DateTimeField(
                null=True,
                blank=True,
                help_text=(
                    "Момент отправки 9-часового уведомления «пора закрыть смену». "
                    "Один DM за смену — защита от повторов."
                ),
            ),
        ),
    ]

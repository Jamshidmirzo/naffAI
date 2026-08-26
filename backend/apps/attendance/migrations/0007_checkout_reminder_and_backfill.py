# Enforcement wave 2026-08-26:
#   - `AttendanceLog.checkout_reminder_sent_at` — spam-guard для нового cron
#     `attendance_checkout_reminder` (один DM/баннер на смену).
#   - `AttendanceLog.backfilled_by_operator_at` — момент, когда оператор
#     ввёл фактический `checked_out_at` задним числом. Не сбрасывает
#     `auto_closed` (аудит остаётся), но исключает лог из счётчика
#     «forgotten checkouts».
#   - `AttendanceSettings.checkout_reminder_after_hours` (default 8) —
#     после скольких часов от check-in слать reminder.
#   - `AttendanceSettings.max_backfill_hours` (default 14) — верхняя
#     граница «во сколько вы вчера ушли?» на backfill endpoint'e.

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("attendance", "0006_attendancelog_attlog_op_checkedout_idx"),
    ]

    operations = [
        migrations.AddField(
            model_name="attendancelog",
            name="checkout_reminder_sent_at",
            field=models.DateTimeField(
                null=True,
                blank=True,
                help_text=(
                    "Момент отправки reminder'a «прошло 8 часов, "
                    "отметьтесь об уходе»."
                ),
            ),
        ),
        migrations.AddField(
            model_name="attendancelog",
            name="backfilled_by_operator_at",
            field=models.DateTimeField(
                null=True,
                blank=True,
                help_text=(
                    "Момент, когда оператор ввёл фактическое время "
                    "ухода задним числом."
                ),
            ),
        ),
        migrations.AddField(
            model_name="attendancesettings",
            name="checkout_reminder_after_hours",
            field=models.PositiveSmallIntegerField(
                default=8,
                help_text=(
                    "После скольких часов от check-in слать reminder "
                    "об уходе (0 = выкл)."
                ),
            ),
        ),
        migrations.AddField(
            model_name="attendancesettings",
            name="max_backfill_hours",
            field=models.PositiveSmallIntegerField(
                default=14,
                help_text=(
                    "Максимальная длительность смены при backfill "
                    "забытого ухода."
                ),
            ),
        ),
    ]

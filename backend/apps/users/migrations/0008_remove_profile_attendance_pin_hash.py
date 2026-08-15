"""
Drop per-manager attendance PIN. PIN переехал в singleton
`attendance.AttendanceSettings.pin_hash` (один общий PIN, ставит только
superadmin — см. `apps.attendance.pin_services`).

Поле было добавлено сутками ранее (0007) и в prod ещё не успело
заполниться реальными данными, поэтому просто dropаем колонку без
data migration.
"""

from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ("users", "0007_profile_attendance_pin_hash"),
    ]

    operations = [
        migrations.RemoveField(
            model_name="profile",
            name="attendance_pin_hash",
        ),
    ]

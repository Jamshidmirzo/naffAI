"""
Add global attendance-PIN fields to `AttendanceSettings` singleton.

2026-08-15 redesign — переезжаем с per-manager PIN (жил в
`users.Profile.attendance_pin_hash`) на один общий PIN, устанавливаемый
только superadmin'ом. См. `apps.attendance.pin_services`.

Миграция чисто аддитивная — все три новых поля nullable/blank/default,
безопасна для prod.
"""

from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("attendance", "0004_attendance_pin_session"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.AddField(
            model_name="attendancesettings",
            name="pin_hash",
            field=models.CharField(
                blank=True,
                default="",
                help_text=(
                    "Django password-hash 4-значного глобального PIN'a. "
                    "Пусто = PIN не задан."
                ),
                max_length=128,
            ),
        ),
        migrations.AddField(
            model_name="attendancesettings",
            name="pin_updated_at",
            field=models.DateTimeField(
                blank=True,
                null=True,
                help_text="Момент последнего set/reset глобального PIN'a.",
            ),
        ),
        migrations.AddField(
            model_name="attendancesettings",
            name="pin_updated_by",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=models.deletion.SET_NULL,
                related_name="+",
                to=settings.AUTH_USER_MODEL,
                help_text="Superadmin, задавший/сбросивший PIN.",
            ),
        ),
    ]

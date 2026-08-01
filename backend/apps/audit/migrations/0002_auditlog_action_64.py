"""
Widen AuditLog.action varchar 16 → 64.

attendance.services logs actions like 'attendance.scan_ok' (18) and
'attendance.stale_session_closed' (30) — these silently 500'd the
scan endpoint with «value too long for type character varying(16)».
Widen the column so any future 'namespace.event' action fits.
"""

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("audit", "0001_initial"),
    ]

    operations = [
        migrations.AlterField(
            model_name="auditlog",
            name="action",
            field=models.CharField(
                choices=[
                    ("create", "Создание"),
                    ("update", "Изменение"),
                    ("delete", "Удаление"),
                    ("override", "Принудительное действие"),
                ],
                max_length=64,
            ),
        ),
    ]

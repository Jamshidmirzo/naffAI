from django.db import migrations


class Migration(migrations.Migration):
    """Joins main's 0016_operator_paused_reason with this branch's 0016/0017."""

    dependencies = [
        ("operators", "0016_operator_paused_reason"),
        ("operators", "0017_require_checkin_default_true"),
    ]

    operations = []

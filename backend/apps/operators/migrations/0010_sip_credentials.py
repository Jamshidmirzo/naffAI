# 2026-09-06: SIP credentials for Flutter mobile operator app.
#
# Both fields are opt-in (blank+default=""). Empty → mobile /me/ returns
# `sip_credentials: null` and the app runs in "no-softphone" mode.
# Manager fills them manually once SIP extension is provisioned on Asterisk.

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("operators", "0009_two_gate_overrides"),
    ]

    operations = [
        migrations.AddField(
            model_name="operator",
            name="sip_username",
            field=models.CharField(
                blank=True,
                default="",
                help_text="SIP username (Asterisk extension). Пусто → SIP выключен для оператора.",
                max_length=64,
            ),
        ),
        migrations.AddField(
            model_name="operator",
            name="sip_password",
            field=models.CharField(
                blank=True,
                default="",
                help_text="SIP password (plaintext). Отдаётся только владельцу через /api/mobile/me/.",
                max_length=128,
            ),
        ),
    ]

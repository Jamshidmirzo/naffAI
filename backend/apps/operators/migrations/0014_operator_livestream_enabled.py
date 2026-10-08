from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("operators", "0013_operator_managed_by"),
    ]

    operations = [
        migrations.AddField(
            model_name="operator",
            name="livestream_enabled",
            field=models.BooleanField(
                default=False,
                help_text=(
                    "Opt-in: включает веб-камеру оператора при логине "
                    "и начинает публиковать поток в LiveKit SFU. По "
                    "умолчанию False — оператор не стримит, пока "
                    "менеджер явно не включит флаг."
                ),
            ),
        ),
    ]

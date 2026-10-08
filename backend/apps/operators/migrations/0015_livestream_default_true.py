from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("operators", "0014_operator_livestream_enabled"),
    ]

    operations = [
        migrations.AlterField(
            model_name="operator",
            name="livestream_enabled",
            field=models.BooleanField(
                default=True,
                help_text=(
                    "Если True — браузер оператора при логине авто-"
                    "публикует webcam в LiveKit (видно менеджеру на "
                    "/live/wall). По умолчанию ВКЛ, чтобы не возиться "
                    "с per-operator opt-in; экстренный глобальный "
                    "killswitch — SystemSetting.livestream_global_enabled."
                ),
            ),
        ),
    ]

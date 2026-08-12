# Auto-generated cosmetic follow-up to 0005_bot_v2 — Django-suggested
# rename to its canonical hash-suffix names + explicit BigAutoField pk.

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("tg_bot", "0005_bot_v2"),
    ]

    operations = [
        migrations.RenameIndex(
            model_name="botauditlog",
            new_name="tg_bot_bota_chat_id_c2830e_idx",
            old_name="tg_bot_bota_chat_id_idx",
        ),
        migrations.RenameIndex(
            model_name="botauditlog",
            new_name="tg_bot_bota_command_c85aa2_idx",
            old_name="tg_bot_bota_command_idx",
        ),
        migrations.RenameIndex(
            model_name="botchat",
            new_name="tg_bot_botc_kind_3b8b69_idx",
            old_name="tg_bot_botc_kind_is_a_idx",
        ),
        migrations.AlterField(
            model_name="botauditlog",
            name="id",
            field=models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID"),
        ),
        migrations.AlterField(
            model_name="botchat",
            name="id",
            field=models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID"),
        ),
        migrations.AlterField(
            model_name="botreport",
            name="id",
            field=models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID"),
        ),
    ]

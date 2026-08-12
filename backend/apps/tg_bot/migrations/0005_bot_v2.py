"""
Bot v2: registry of chats, configurable scheduled reports, and an
append-only audit log for every bot interaction.

Old `BotSubscription` stays for back-compat with the legacy daily
scheduler; new code paths use `BotChat` + `BotReport`.
"""

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("tg_bot", "0004_botsubscription_last_daily_report_date"),
        ("users", "0001_initial"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name="BotChat",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("chat_id", models.BigIntegerField(db_index=True, unique=True)),
                (
                    "kind",
                    models.CharField(
                        choices=[
                            ("private", "Приват"),
                            ("group", "Группа"),
                            ("supergroup", "Супергруппа"),
                            ("channel", "Канал"),
                        ],
                        max_length=16,
                    ),
                ),
                ("title", models.CharField(blank=True, default="", max_length=256)),
                (
                    "language",
                    models.CharField(
                        choices=[("ru", "Русский"), ("uz", "Oʻzbekcha")],
                        default="uz",
                        max_length=4,
                    ),
                ),
                ("is_active", models.BooleanField(db_index=True, default=True)),
                ("blocked_at", models.DateTimeField(blank=True, null=True)),
                ("last_seen_at", models.DateTimeField(auto_now=True)),
                (
                    "linked_profile",
                    models.ForeignKey(
                        blank=True,
                        help_text="For private chats: which app-user this DM belongs to (set via /link).",
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="bot_chats",
                        to="users.profile",
                    ),
                ),
            ],
            options={
                "ordering": ["-last_seen_at"],
                "indexes": [
                    models.Index(
                        fields=["kind", "is_active"], name="tg_bot_botc_kind_is_a_idx"
                    )
                ],
            },
        ),
        migrations.CreateModel(
            name="BotReport",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("name", models.CharField(max_length=128)),
                ("enabled", models.BooleanField(db_index=True, default=True)),
                (
                    "schedule_time",
                    models.TimeField(
                        help_text="HH:MM in Asia/Tashkent when the report should fire."
                    ),
                ),
                (
                    "schedule_days",
                    models.JSONField(
                        blank=True,
                        default=list,
                        help_text='List of weekday keys ["mon","tue",...]; empty = every day.',
                    ),
                ),
                ("blocks", models.JSONField(blank=True, default=list)),
                (
                    "language",
                    models.CharField(
                        choices=[("ru", "Русский"), ("uz", "Oʻzbekcha")],
                        default="uz",
                        max_length=4,
                    ),
                ),
                (
                    "period",
                    models.CharField(
                        choices=[
                            ("today", "Сегодня"),
                            ("yesterday", "Вчера"),
                            ("week", "Неделя"),
                            ("month", "Месяц"),
                        ],
                        default="today",
                        max_length=16,
                    ),
                ),
                ("include_header", models.BooleanField(default=True)),
                ("last_sent_at", models.DateTimeField(blank=True, null=True)),
                ("last_send_error", models.TextField(blank=True, default="")),
                (
                    "created_by",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="created_bot_reports",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
                (
                    "recipients",
                    models.ManyToManyField(
                        blank=True, related_name="reports", to="tg_bot.botchat"
                    ),
                ),
            ],
            options={"ordering": ["-created_at"]},
        ),
        migrations.CreateModel(
            name="BotAuditLog",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False)),
                ("at", models.DateTimeField(auto_now_add=True, db_index=True)),
                ("chat_id", models.BigIntegerField(db_index=True)),
                ("chat_kind", models.CharField(blank=True, default="", max_length=16)),
                ("tg_user_id", models.BigIntegerField(blank=True, db_index=True, null=True)),
                ("username", models.CharField(blank=True, default="", max_length=64)),
                ("linked_operator_id", models.BigIntegerField(blank=True, null=True)),
                ("command", models.CharField(max_length=64)),
                ("args", models.TextField(blank=True, default="")),
                (
                    "outcome",
                    models.CharField(
                        choices=[
                            ("ok", "ok"),
                            ("denied", "denied"),
                            ("error", "error"),
                            ("unlinked", "unlinked"),
                            ("scheduled_sent", "scheduled_sent"),
                        ],
                        default="ok",
                        max_length=32,
                    ),
                ),
                ("error_detail", models.TextField(blank=True, default="")),
            ],
            options={
                "ordering": ["-at"],
                "indexes": [
                    models.Index(fields=["chat_id", "-at"], name="tg_bot_bota_chat_id_idx"),
                    models.Index(fields=["command", "-at"], name="tg_bot_bota_command_idx"),
                ],
            },
        ),
    ]

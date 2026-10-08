from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    initial = True

    dependencies = [
        # Must land AFTER operators.0014 so Operator.livestream_enabled
        # exists before the frontend / backend starts referencing it.
        ("operators", "0014_operator_livestream_enabled"),
    ]

    operations = [
        migrations.CreateModel(
            name="LivestreamSession",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("room_name", models.CharField(db_index=True, max_length=64)),
                ("participant_identity", models.CharField(db_index=True, max_length=64)),
                ("started_at", models.DateTimeField(db_index=True)),
                ("ended_at", models.DateTimeField(blank=True, null=True)),
                (
                    "status",
                    models.CharField(
                        choices=[("live", "В эфире"), ("ended", "Завершена"), ("lost", "Потеряна")],
                        db_index=True,
                        default="live",
                        max_length=16,
                    ),
                ),
                ("metadata", models.JSONField(blank=True, default=dict)),
                (
                    "operator",
                    models.ForeignKey(
                        on_delete=models.deletion.CASCADE,
                        related_name="livestream_sessions",
                        to="operators.operator",
                    ),
                ),
            ],
            options={
                "indexes": [
                    models.Index(fields=["status", "started_at"], name="livestream__status_c942ea_idx"),
                    models.Index(fields=["operator", "started_at"], name="livestream__operato_96ca23_idx"),
                ],
            },
        ),
        migrations.CreateModel(
            name="RecordingSession",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("room_name", models.CharField(db_index=True, max_length=64)),
                ("participant_identity", models.CharField(db_index=True, max_length=64)),
                (
                    "egress_id",
                    models.CharField(
                        help_text="LiveKit egress ID (ingress for webhook idempotency).",
                        max_length=64,
                        unique=True,
                    ),
                ),
                (
                    "status",
                    models.CharField(
                        choices=[
                            ("pending", "Запускается"),
                            ("recording", "Пишется"),
                            ("finished", "Готова"),
                            ("failed", "Ошибка"),
                            ("deleted", "Удалена"),
                        ],
                        db_index=True,
                        default="pending",
                        max_length=16,
                    ),
                ),
                ("s3_bucket", models.CharField(blank=True, default="", max_length=128)),
                ("s3_key", models.CharField(blank=True, default="", max_length=512)),
                ("started_at", models.DateTimeField(blank=True, null=True)),
                ("ended_at", models.DateTimeField(blank=True, null=True)),
                ("duration_s", models.PositiveIntegerField(blank=True, null=True)),
                ("size_bytes", models.BigIntegerField(blank=True, null=True)),
                ("error_text", models.TextField(blank=True, default="")),
                (
                    "livestream_session",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=models.deletion.SET_NULL,
                        related_name="recordings",
                        to="livestream.livestreamsession",
                    ),
                ),
                (
                    "operator",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=models.deletion.SET_NULL,
                        related_name="recordings",
                        to="operators.operator",
                    ),
                ),
            ],
            options={
                "ordering": ["-started_at", "-id"],
                "indexes": [
                    models.Index(fields=["operator", "started_at"], name="livestream__operato_e17bb2_idx"),
                    models.Index(fields=["status", "started_at"], name="livestream__status_1abaae_idx"),
                ],
            },
        ),
        migrations.CreateModel(
            name="LiveKitWebhookEvent",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("event_id", models.CharField(max_length=128, unique=True)),
                ("event_type", models.CharField(db_index=True, max_length=64)),
                ("payload", models.JSONField()),
                ("received_at", models.DateTimeField(auto_now_add=True, db_index=True)),
            ],
            options={
                "indexes": [
                    models.Index(fields=["event_type", "received_at"], name="livestream__event_t_50ca07_idx"),
                ],
            },
        ),
    ]

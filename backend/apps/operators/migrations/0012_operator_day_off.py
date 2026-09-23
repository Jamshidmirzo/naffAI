from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("operators", "0011_operator_pause"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name="OperatorDayOff",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("date", models.DateField(db_index=True)),
                (
                    "status",
                    models.CharField(
                        choices=[
                            ("pending", "На рассмотрении"),
                            ("approved", "Одобрен"),
                            ("rejected", "Отклонён"),
                        ],
                        default="pending",
                        max_length=16,
                    ),
                ),
                ("reason", models.TextField(blank=True, default="")),
                ("decided_at", models.DateTimeField(blank=True, null=True)),
                ("decision_note", models.TextField(blank=True, default="")),
                (
                    "operator",
                    models.ForeignKey(
                        on_delete=models.deletion.CASCADE,
                        related_name="day_offs",
                        to="operators.operator",
                    ),
                ),
                (
                    "requested_by",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=models.deletion.SET_NULL,
                        related_name="+",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
                (
                    "decided_by",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=models.deletion.SET_NULL,
                        related_name="+",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
            ],
        ),
        migrations.AddIndex(
            model_name="operatordayoff",
            index=models.Index(fields=["status", "date"], name="operators_o_status_da_idx"),
        ),
        migrations.AddConstraint(
            model_name="operatordayoff",
            constraint=models.UniqueConstraint(
                condition=models.Q(("status", "rejected"), _negated=True),
                fields=("operator", "date"),
                name="uniq_operator_day_off_active",
            ),
        ),
    ]

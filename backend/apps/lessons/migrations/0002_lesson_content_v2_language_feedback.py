import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("lessons", "0001_initial"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.AddField(
            model_name="dailylesson",
            name="content",
            field=models.JSONField(
                blank=True,
                default=dict,
                help_text=(
                    "Полный JSON нового v2 промпта: {greeting_line, "
                    "yesterday_summary, main_insight{title,text}, "
                    "highlights[{title,evidence}], "
                    "blockers[{title,why,example}], "
                    "practice_today[{step,when,how}], micro_lesson, "
                    "closing_line}. Пустой dict = старый v1 урок."
                ),
            ),
        ),
        migrations.AddField(
            model_name="dailylesson",
            name="language",
            field=models.CharField(
                default="ru",
                help_text="Язык AI-контента: 'ru' или 'uz'.",
                max_length=8,
            ),
        ),
        migrations.AlterField(
            model_name="dailylesson",
            name="summary",
            field=models.TextField(
                blank=True,
                default="",
                help_text="Абзац: как прошёл день",
            ),
        ),
        migrations.CreateModel(
            name="DailyLessonFeedback",
            fields=[
                (
                    "id",
                    models.BigAutoField(
                        auto_created=True,
                        primary_key=True,
                        serialize=False,
                        verbose_name="ID",
                    ),
                ),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                (
                    "rating",
                    models.CharField(
                        choices=[("helpful", "Полезно"), ("not_helpful", "Не полезно")],
                        max_length=16,
                    ),
                ),
                ("comment", models.TextField(blank=True, default="")),
                (
                    "lesson",
                    models.OneToOneField(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="feedback",
                        to="lessons.dailylesson",
                    ),
                ),
                (
                    "created_by",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="+",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
            ],
            options={
                "abstract": False,
            },
        ),
    ]

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("leads", "0018_dokonga_keladi_carry"),
    ]

    operations = [
        migrations.AddField(
            model_name="leadstatuslabel",
            name="recall_after_lunch",
            field=models.BooleanField(
                db_index=True,
                default=False,
                help_text=(
                    "После обеда (13:00 Asia/Tashkent) лид с таким статусом, "
                    "выставленным до обеда, снова становится активным и всплывает "
                    "наверх /my как intraday-carry. Используется для no_answer / "
                    "phone_on: утром «не ответил» — днём попробуй ещё раз."
                ),
            ),
        ),
    ]

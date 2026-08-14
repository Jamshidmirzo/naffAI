# Generated 2026-08-14 for attendance photo confirmation redesign.
#
# Additive migration: adds nullable photo fields on AttendanceLog and
# three new toggles on AttendanceSettings (defaults keep back-compat —
# require_photo=False → existing scans keep working without photo).

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("attendance", "0002_attendancelog_long_shift_warning_sent_at_and_more"),
    ]

    operations = [
        migrations.AddField(
            model_name="attendancelog",
            name="checkin_photo",
            field=models.ImageField(
                blank=True,
                help_text="Фото при check-in (обнуляется через 30 дней)",
                null=True,
                upload_to="attendance/%Y/%m/",
            ),
        ),
        migrations.AddField(
            model_name="attendancelog",
            name="checkout_photo",
            field=models.ImageField(
                blank=True,
                help_text="Фото при check-out (обнуляется через 30 дней)",
                null=True,
                upload_to="attendance/%Y/%m/",
            ),
        ),
        migrations.AddField(
            model_name="attendancelog",
            name="checkin_photo_phash",
            field=models.CharField(
                blank=True,
                db_index=True,
                default="",
                help_text="Perceptual hash фото — анти-дубль на 24ч",
                max_length=16,
            ),
        ),
        migrations.AddField(
            model_name="attendancelog",
            name="checkout_photo_phash",
            field=models.CharField(
                blank=True, db_index=True, default="", max_length=16
            ),
        ),
        migrations.AddField(
            model_name="attendancesettings",
            name="require_photo",
            field=models.BooleanField(
                default=False,
                help_text="Требовать фото при каждом скане (иначе фото опционально)",
            ),
        ),
        migrations.AddField(
            model_name="attendancesettings",
            name="require_face",
            field=models.BooleanField(
                default=True,
                help_text="Если фото передано — проверять наличие лица (MediaPipe)",
            ),
        ),
        migrations.AddField(
            model_name="attendancesettings",
            name="photo_max_size_mb",
            field=models.PositiveSmallIntegerField(
                default=5, help_text="Лимит размера фото в мегабайтах"
            ),
        ),
    ]

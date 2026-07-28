from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('leads', '0004_sheetsource_distribution'),
    ]

    operations = [
        migrations.AlterField(
            model_name='lead',
            name='status',
            field=models.CharField(
                choices=[
                    ('new', 'Новый'),
                    ('assigned', 'Назначен'),
                    ('in_progress', 'В работе'),
                    ('callback_scheduled', 'Запланирован callback'),
                    ('contacted_telegram', 'Написали в Telegram'),
                    ('no_answer', 'Не ответил (1)'),
                    ('no_answer_2', 'Не ответил (2)'),
                    ('phone_on', 'Телефон включён'),
                    ('has_debt', 'У клиента долг'),
                    ('won', 'Продажа'),
                    ('lost', 'Потерян'),
                    ('archived', 'Архив'),
                    ('needs_review', 'Требует проверки'),
                ],
                db_index=True,
                default='new',
                max_length=32,
            ),
        ),
        migrations.AlterField(
            model_name='sheetsource',
            name='default_status',
            field=models.CharField(
                choices=[
                    ('new', 'Новый'),
                    ('assigned', 'Назначен'),
                    ('in_progress', 'В работе'),
                    ('callback_scheduled', 'Запланирован callback'),
                    ('contacted_telegram', 'Написали в Telegram'),
                    ('no_answer', 'Не ответил (1)'),
                    ('no_answer_2', 'Не ответил (2)'),
                    ('phone_on', 'Телефон включён'),
                    ('has_debt', 'У клиента долг'),
                    ('won', 'Продажа'),
                    ('lost', 'Потерян'),
                    ('archived', 'Архив'),
                    ('needs_review', 'Требует проверки'),
                ],
                default='new',
                max_length=32,
            ),
        ),
    ]

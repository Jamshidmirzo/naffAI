"""
Singleton-настройки всей системы. Хранится ровно одна строка (pk=1).
Пока здесь только флаг `auto_distribution_enabled` — killswitch для
morning-split / refill-on-close / distribute-watcher.

Если понадобятся ещё глобальные тумблеры (например, «выключить
sheet-sync» или «пауза на TG-бота») — добавляем сюда же, чтобы не
разводить микро-таблицы.
"""

from __future__ import annotations

from django.conf import settings
from django.db import models


class SystemSetting(models.Model):
    auto_distribution_enabled = models.BooleanField(
        default=True,
        help_text=(
            "Если False — утренний split, refill-по-N при закрытии лида и "
            "watcher-минутка ничего не раздают. Всё распределение вручную."
        ),
    )
    morning_gate_enabled = models.BooleanField(
        default=True,
        help_text=(
            "Если True — оператору не выдаются новые лиды через RR, пока у "
            "него есть просроченный/скорый callback или хотя бы один лид в "
            "статусе с флагом `blocks_new_leads`. Восстанавливает старое "
            "поведение «спец-лиды блокируют раздачу»."
        ),
    )
    retry_export_spreadsheet_id = models.CharField(
        max_length=100,
        blank=True,
        default="",
        help_text=(
            "ID Google Sheet, куда экспортируются лиды со статусами "
            "sms_jonatildi + contacted_telegram по кнопке «Сформировать "
            "retry-лист». Если пусто — берётся `spreadsheet_id` первого "
            "активного SheetSource."
        ),
    )
    retry_export_tab_name = models.CharField(
        max_length=100,
        default="Retry SMS+TG",
        help_text=(
            "Название tab'а внутри retry-export spreadsheet'а. Создаётся "
            "автоматически на первом экспорте; при повторном экспорте "
            "содержимое tab'а полностью перезаписывается."
        ),
    )
    updated_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="+",
    )
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = "Системная настройка"
        verbose_name_plural = "Системные настройки"

    def __str__(self) -> str:
        return f"SystemSetting(auto_distribution_enabled={self.auto_distribution_enabled})"

    @classmethod
    def get_solo(cls) -> SystemSetting:
        """
        Ленивая инициализация singleton'а. Первый вызов создаёт строку
        pk=1 с дефолтами; последующие возвращают её. Никогда не бросает
        DoesNotExist — безопасно вызывать до/после миграций.
        """
        obj, _ = cls.objects.get_or_create(pk=1)
        return obj

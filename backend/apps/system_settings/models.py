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

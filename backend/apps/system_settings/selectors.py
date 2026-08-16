"""
Read-side: тонкие обёртки над singleton'ом.
"""

from __future__ import annotations

from .models import SystemSetting


def auto_distribution_enabled() -> bool:
    """
    Хот-путь (dозов много: morning, watcher, каждый close лида).
    Прямой SQL-хит на 1-row таблицу; кеш не нужен.
    """
    return SystemSetting.get_solo().auto_distribution_enabled


def morning_gate_enabled() -> bool:
    """
    Хот-путь: читается на каждый RR-выбор и на каждый GET /my.
    Прямой SQL-хит на 1-row таблицу; кеш не нужен (postgres кеширует
    сам за счёт shared buffers, и таблица warm с первого запроса).
    """
    return SystemSetting.get_solo().morning_gate_enabled


def system_setting_get() -> SystemSetting:
    return SystemSetting.get_solo()

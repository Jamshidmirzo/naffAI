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


def system_setting_get() -> SystemSetting:
    return SystemSetting.get_solo()

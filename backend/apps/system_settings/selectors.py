"""
Read-side: тонкие обёртки над singleton'ом.
"""

from __future__ import annotations

from .models import SystemSetting


# Дефолтный набор retry-export статусов (обратная совместимость с
# захардкоженным списком, что жил в apps.leads.selectors:1304).
# Если менеджер ещё не сохранил свой набор через /api/settings/retry-export/,
# селектор `get_retry_export_statuses` возвращает эти четыре кода.
DEFAULT_RETRY_EXPORT_STATUSES: tuple[str, ...] = (
    "sms_jonatildi",
    "contacted_telegram",
    "no_answer",
    "no_answer_2",
)


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


def get_retry_export_statuses() -> list[str]:
    """
    Возвращает список кодов LeadStatusLabel для retry-export'a.

    Если менеджер сохранил кастомный набор через UI — вернём его.
    Если поле пустое (свежая инсталляция / до первого сохранения) —
    возвращаем DEFAULT_RETRY_EXPORT_STATUSES (backwards-compat).
    """
    raw = SystemSetting.get_solo().retry_export_statuses or []
    # Фильтруем неструктурные значения (str only), чтобы малейший
    # мусор в JSONField не крашил Google Sheets export.
    codes = [c for c in raw if isinstance(c, str) and c.strip()]
    if not codes:
        return list(DEFAULT_RETRY_EXPORT_STATUSES)
    return codes


def system_setting_get() -> SystemSetting:
    return SystemSetting.get_solo()

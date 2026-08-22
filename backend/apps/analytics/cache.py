"""
Wave-1 cache layer (2026-08-22).

Кеш применяется к тяжёлым select-only endpoint'ам, которые:
1. Отдают агрегаты по всем продажам/лидам за окно.
2. Тянутся часто (dashboard-summary — на каждом монтировании главной,
   lead-stats — на каждом обновлении менеджера).
3. Толерантны к 60-секундной устарелости: между продажами/статусами
   менеджеру нормально видеть данные не свежее минуты.

Инвалидация — ручная, из sale/lead-сервисов (`transaction.on_commit`
чтобы не сбросить кеш до фактического commit'a). Никаких сигналов
(HackSoft styleguide — сервис знает, что он изменил).
"""

from __future__ import annotations

from django.core.cache import cache

# TTL синхронизирован между всеми записываемыми ключами: 60 секунд —
# достаточно чтобы схлопнуть пик из десятков одновременных «open dashboard»
# в один DB-hit, но достаточно мало, чтобы обычная задержка после
# продажи/статуса была незаметной (mutation invalidates by hand).
DASHBOARD_SUMMARY_TTL = 60
LEAD_STATS_TTL = 60

# Известные значения `period` для dashboard-summary. Держим список
# явно — чтобы invalidation могла точечно снести все три ключа за один
# `delete_many` без ошибок «а вдруг ещё какой period».
DASHBOARD_PERIODS = ("day", "week", "month")


def dashboard_summary_key(period: str) -> str:
    return f"dash-summary:{period}"


def lead_stats_key(date_from_iso: str, date_to_iso: str) -> str:
    # Диапазон входит в ключ — иначе разные окна отдавали бы один кеш.
    return f"lead-stats:{date_from_iso}:{date_to_iso}"


def invalidate_sale_caches() -> None:
    """
    Сносит все ключи, которые пересчитаются после mutation'а продажи:
    - dashboard-summary для day / week / month;
    - lead-stats (все окна — по префиксу, если Redis-backend умеет
      delete_pattern; иначе `cache.clear` слишком агрессивен, оставляем
      только dashboard).

    Best-effort — ошибки Redis'a молча игнорируются (см.
    IGNORE_EXCEPTIONS в settings).
    """
    keys = [dashboard_summary_key(p) for p in DASHBOARD_PERIODS]
    try:
        cache.delete_many(keys)
    except Exception:
        # settings IGNORE_EXCEPTIONS=True на prod поглотит уже там,
        # но dev/LocMem не бросается, так что второй barrier тут.
        pass
    # LeadStats — окна разные, не знаем какой именно оператор смотрел.
    # django-redis умеет delete_pattern; для LocMem — no-op.
    try:
        cache.delete_pattern("*lead-stats:*")  # type: ignore[attr-defined]
    except (AttributeError, Exception):  # noqa: BLE001
        pass


def invalidate_lead_caches() -> None:
    """
    Смена статуса лида → сносим и dashboard (KPI меняется), и lead-stats.
    """
    invalidate_sale_caches()

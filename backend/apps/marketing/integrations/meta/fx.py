"""
Курс ЦБ Узбекистана (cbu.uz) для пересчёта расхода Meta (обычно USD) в сумы.

Открытый JSON без ключа:
  GET https://cbu.uz/uz/arkhiv-kursov-valyut/json/USD/2026-11-02/
  → [{"Ccy": "USD", "Rate": "12063.71", "Date": "02.11.2026", ...}]
На выходные ЦБ отдаёт последний курс. Кэшируем в `marketing.FxRate`; если
ЦБ недоступен — берём ближайший более ранний курс из кэша.
"""

from __future__ import annotations

import datetime as dt
import logging
from collections.abc import Callable, Iterable
from decimal import Decimal, InvalidOperation

import httpx

from apps.marketing.models import FxRate

logger = logging.getLogger("apps.marketing.meta")

CBU_URL = "https://cbu.uz/uz/arkhiv-kursov-valyut/json/{ccy}/{day}/"

Fetcher = Callable[[str, dt.date], Decimal | None]


def cbu_fetch_rate(currency: str, day: dt.date) -> Decimal | None:
    try:
        resp = httpx.get(CBU_URL.format(ccy=currency, day=day.isoformat()), timeout=10)
        resp.raise_for_status()
        rows = resp.json()
    except (httpx.HTTPError, ValueError) as exc:
        logger.warning("cbu: %s %s failed: %s", currency, day, exc)
        return None
    for row in rows if isinstance(rows, list) else []:
        if str(row.get("Ccy", "")).upper() == currency.upper():
            try:
                return Decimal(str(row.get("Rate")))
            except (InvalidOperation, TypeError):
                return None
    return None


def fx_rates_ensure(
    currency: str, days: Iterable[dt.date], *, fetch: Fetcher | None = None
) -> int:
    """Скачивает недостающие курсы. Возвращает, сколько записали."""
    currency = (currency or "").upper()
    if not currency or currency == "UZS":
        return 0
    wanted = sorted(set(days))
    if not wanted:
        return 0
    have = set(
        FxRate.objects.filter(currency=currency, date__in=wanted).values_list("date", flat=True)
    )
    fetch = fetch or cbu_fetch_rate
    written = 0
    for day in wanted:
        if day in have:
            continue
        rate = fetch(currency, day)
        if rate is None:
            # ЦБ лежит / нет сети — не долбим его по каждому дню.
            break
        FxRate.objects.update_or_create(date=day, currency=currency, defaults={"rate": rate})
        written += 1
    return written


class FxTable:
    """
    Курсы на диапазон дат с откатом к ближайшему более раннему дню.
    `to_uzs(amount, currency, day)` → Decimal | None (None = курса нет вовсе).
    """

    def __init__(self, currencies: Iterable[str], date_from: dt.date, date_to: dt.date) -> None:
        self._rates: dict[str, list[tuple[dt.date, Decimal]]] = {}
        for cur in {c.upper() for c in currencies if c}:
            if cur == "UZS":
                continue
            rows = list(
                FxRate.objects.filter(currency=cur, date__lte=date_to)
                .filter(date__gte=date_from - dt.timedelta(days=30))
                .order_by("date")
                .values_list("date", "rate")
            )
            if not rows or rows[0][0] > date_from:
                prev = (
                    FxRate.objects.filter(currency=cur, date__lt=date_from)
                    .order_by("-date")
                    .values_list("date", "rate")
                    .first()
                )
                if prev:
                    rows.insert(0, prev)
            if not rows:
                # Совсем нет истории — хотя бы самый свежий курс.
                latest = (
                    FxRate.objects.filter(currency=cur)
                    .order_by("-date")
                    .values_list("date", "rate")
                    .first()
                )
                if latest:
                    rows = [latest]
            self._rates[cur] = rows

    def rate(self, currency: str, day: dt.date) -> Decimal | None:
        cur = (currency or "").upper()
        if cur in ("", "UZS"):
            return Decimal("1")
        rows = self._rates.get(cur) or []
        best: Decimal | None = None
        for d, r in rows:
            if d <= day:
                best = r
            else:
                break
        if best is None and rows:
            best = rows[0][1]
        return best

    def to_uzs(self, amount: Decimal, currency: str, day: dt.date) -> Decimal | None:
        rate = self.rate(currency, day)
        if rate is None:
            return None
        return amount * rate


__all__ = ["FxTable", "cbu_fetch_rate", "fx_rates_ensure"]

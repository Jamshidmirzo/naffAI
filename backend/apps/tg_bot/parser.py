"""
Lightweight, dependency-free message parser used by the Telegram bot
(and unit tests). Designed for messages like:

    IMEI: 490154203237518
    модель: iPhone 13 Pro
    продал(а): Алишер

We deliberately keep the regex loose — the parser is a *hint generator*,
not a validator. The actual save still runs through `sale_create` with
full IMEI/duplicate checks.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

IMEI_RE = re.compile(r"(?<!\d)(\d{15})(?!\d)")
SELLER_RE = re.compile(
    r"(?:продал[аи]?|seller|оператор|sold\s*by|кто[\s_-]*продал)\s*[:\-]?\s*([^\n]+)",
    re.IGNORECASE,
)
MODEL_RE = re.compile(
    r"(?:модель|model|телефон|устройство)\s*[:\-]?\s*([^\n]+)",
    re.IGNORECASE,
)
AMOUNT_RE = re.compile(
    r"(?:сумма|цена|amount|price|стоимость)\s*[:\-]?\s*([\d\s.,]+)",
    re.IGNORECASE,
)


@dataclass
class ParsedSale:
    imei: str | None
    model: str | None
    seller_hint: str | None
    amount: str | None
    raw: str


def parse_message(text: str) -> ParsedSale:
    imei_match = IMEI_RE.search(text or "")
    seller = SELLER_RE.search(text or "")
    model = MODEL_RE.search(text or "")
    amount = AMOUNT_RE.search(text or "")
    return ParsedSale(
        imei=imei_match.group(1) if imei_match else None,
        model=(model.group(1).strip() if model else None),
        seller_hint=(seller.group(1).strip() if seller else None),
        amount=(re.sub(r"[\s,]", "", amount.group(1)) if amount else None),
        raw=text or "",
    )

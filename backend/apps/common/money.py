"""
UZS money is stored as Decimal(14, 2). Helpers for parsing/formatting.
Never use float for money in this codebase.
"""

from __future__ import annotations

from decimal import Decimal, InvalidOperation


def to_money(value: str | int | float | Decimal) -> Decimal:
    if isinstance(value, Decimal):
        return value.quantize(Decimal("0.01"))
    try:
        return Decimal(str(value)).quantize(Decimal("0.01"))
    except (InvalidOperation, ValueError) as exc:
        raise ValueError(f"Invalid money value: {value!r}") from exc


def format_uzs(value: Decimal | int) -> str:
    """`50000000` -> `'50 000 000 сум'`. Used in Excel exports for display strings."""
    integer = int(value)
    s = f"{integer:,}".replace(",", " ")
    return f"{s} сум"

"""
Pure validator functions used across the project.

Lives in `common` because both `sales` and `catalog`
(and the Telegram bot) need IMEI validation, and we want a
single source of truth.
"""

from __future__ import annotations


def luhn_checksum(digits: str) -> int:
    """
    Compute Luhn checksum on a numeric string.
    Returns the checksum digit; valid number iff returned value == 0.
    """
    total = 0
    parity = len(digits) % 2
    for i, ch in enumerate(digits):
        n = int(ch)
        if i % 2 == parity:
            n *= 2
            if n > 9:
                n -= 9
        total += n
    return total % 10


def is_valid_imei(imei: str) -> bool:
    """
    True iff `imei` is exactly 15 digits and passes Luhn.

    We intentionally do not strip whitespace here — input normalization
    is the caller's job. We do not accept 14-digit (no checksum) IMEIs.
    """
    if not imei or len(imei) != 15 or not imei.isdigit():
        return False
    return luhn_checksum(imei) == 0


def extract_tac(imei: str) -> str:
    """First 8 digits of the IMEI = the TAC (Type Allocation Code)."""
    return imei[:8]

"""
Pure validator functions used across the project.

Lives in `common` because both `sales` and `catalog`
(and the Telegram bot) need IMEI validation, and we want a
single source of truth.
"""

from __future__ import annotations


def is_valid_imei(imei: str) -> bool:
    """True iff `imei` is exactly 15 digits. No checksum check."""
    return bool(imei) and len(imei) == 15 and imei.isdigit()


def extract_tac(imei: str) -> str:
    """First 8 digits of the IMEI = the TAC (Type Allocation Code)."""
    return imei[:8]

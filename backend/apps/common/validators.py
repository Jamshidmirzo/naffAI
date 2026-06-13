"""
Pure validator functions used across the project.

Lives in `common` because both `sales` and `catalog`
(and the Telegram bot) need IMEI validation, and we want a
single source of truth.
"""

from __future__ import annotations


IMEI_MIN_LEN = 6
IMEI_MAX_LEN = 15


def is_valid_imei(imei: str) -> bool:
    """True iff `imei` is digits-only and 6–15 chars long."""
    return bool(imei) and IMEI_MIN_LEN <= len(imei) <= IMEI_MAX_LEN and imei.isdigit()


def extract_tac(imei: str) -> str:
    """First 8 digits of the IMEI = the TAC (Type Allocation Code)."""
    return imei[:8]

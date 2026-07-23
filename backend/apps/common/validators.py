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


import re  # noqa: E402

_UZ_PHONE_LEN = 9
_UZ_PHONE_PREFIX = "+998"


def normalize_uz_phone(raw: str | None) -> tuple[str, bool]:
    """
    Normalize an Uzbek phone number to `+998XXXXXXXXX`.

    Strategy: strip everything non-digit, keep the last 9 digits, prepend
    `+998`. Anything shorter than 9 digits is treated as unparseable.

    Returns `(normalized, is_valid)`. When invalid, `normalized` is the
    best-effort representation (may be empty) — callers should surface
    the raw value from the source and mark the record for review.
    """
    if not raw:
        return "", False
    digits = re.sub(r"\D", "", str(raw))
    if len(digits) < _UZ_PHONE_LEN:
        return "", False
    tail = digits[-_UZ_PHONE_LEN:]
    normalized = f"{_UZ_PHONE_PREFIX}{tail}"
    return normalized, len(normalized) == len(_UZ_PHONE_PREFIX) + _UZ_PHONE_LEN

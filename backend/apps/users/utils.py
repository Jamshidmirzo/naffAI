"""
Small helpers shared across the users app.
"""

from __future__ import annotations

import base64
import secrets

# 32 crockford-ish base32 alphabet minus visually-ambiguous chars.
# We deliberately avoid I / L / 0 / 1 / O to reduce copy-typing errors when
# managers dictate a password over the phone.
_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"


def generate_temp_password(random_len: int = 6) -> str:
    """
    Generate a fresh temporary password like `Naff-3F9K2Q`.

    Kept short and readable — this is a bootstrap credential that the
    operator is expected to change on first login. Uses `secrets` for
    RNG, not `random`.
    """
    tail = "".join(secrets.choice(_ALPHABET) for _ in range(random_len))
    return f"Naff-{tail}"


def generate_fernet_key() -> str:
    """
    Produce a Fernet-compatible base64 key. Used by the dev/test fallback
    in `settings` and by the CLI hint in `.env.example`.
    """
    return base64.urlsafe_b64encode(secrets.token_bytes(32)).decode("ascii")

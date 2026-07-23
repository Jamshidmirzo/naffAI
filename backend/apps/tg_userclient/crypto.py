"""
Symmetric encryption for Telethon StringSession values.

Thin wrapper on top of ``apps.common.crypto.tg_session_vault``. Uses a
SEPARATE Fernet key from the operator-password vault so leaking one
key does not compromise the other.

Key rotation
------------
``TgSession.encrypted_session`` is paired with a ``key_version`` column
so we can rotate without invalidating old rows.
"""

from __future__ import annotations

from apps.common.crypto import FernetVaultError, tg_session_vault


class TgSessionCryptoError(FernetVaultError):
    pass


def encrypt_session(plain: str) -> tuple[bytes, int]:
    """Encrypt a Telethon StringSession — returns ``(ciphertext, key_version)``."""
    try:
        return tg_session_vault.encrypt(plain)
    except FernetVaultError as exc:
        raise TgSessionCryptoError(str(exc)) from exc


def decrypt_session(ciphertext: bytes | memoryview, *, key_version: int = 1) -> str:
    """Decrypt a previously encrypted session string."""
    try:
        return tg_session_vault.decrypt(ciphertext, version=key_version)
    except FernetVaultError as exc:
        raise TgSessionCryptoError(str(exc)) from exc

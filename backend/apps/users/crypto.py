"""
Symmetric encryption for operator passwords.

Thin wrapper on top of ``apps.common.crypto.operator_password_vault``.
Kept as a separate module so the users app has a stable import path and
because the ``OperatorPasswordCryptoError`` alias predates the refactor
and is referenced by tests.

Key rotation
------------
``OperatorSecret.encrypted_password`` is paired with a ``key_version``
column so we can rotate the Fernet key without invalidating old rows.
See ``rotate_operator_secrets`` management command and the
``FernetVault`` docs.
"""

from __future__ import annotations

from apps.common.crypto import FernetVaultError, operator_password_vault


class OperatorPasswordCryptoError(FernetVaultError):
    pass


def encrypt_password(plain: str) -> tuple[bytes, int]:
    """Encrypt and return ``(ciphertext, key_version)``."""
    try:
        return operator_password_vault.encrypt(plain)
    except FernetVaultError as exc:
        raise OperatorPasswordCryptoError(str(exc)) from exc


def decrypt_password(ciphertext: bytes | memoryview, *, key_version: int = 1) -> str:
    """Decrypt a password ciphertext previously produced by ``encrypt_password``."""
    try:
        return operator_password_vault.decrypt(ciphertext, version=key_version)
    except FernetVaultError as exc:
        raise OperatorPasswordCryptoError(str(exc)) from exc

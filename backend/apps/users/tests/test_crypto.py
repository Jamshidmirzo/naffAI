import pytest
from cryptography.fernet import Fernet
from django.test import override_settings

from apps.users.crypto import (
    OperatorPasswordCryptoError,
    decrypt_password,
    encrypt_password,
)


def test_roundtrip_returns_original_plaintext():
    cipher, version = encrypt_password("Naff-3F9K2Q")
    assert decrypt_password(cipher, key_version=version) == "Naff-3F9K2Q"


def test_empty_plain_rejected():
    with pytest.raises(OperatorPasswordCryptoError):
        encrypt_password("")


def test_wrong_key_fails_to_decrypt():
    cipher, version = encrypt_password("supersecret1")
    other = Fernet.generate_key().decode()
    # Substitute both keys dict AND single-key fallback so nothing decrypts.
    with override_settings(
        OPERATOR_PASSWORD_ENCRYPTION_KEY=other,
        OPERATOR_PASSWORD_ENCRYPTION_KEYS={"1": other},
        OPERATOR_PASSWORD_ENCRYPTION_CURRENT_VERSION=1,
    ):
        with pytest.raises(OperatorPasswordCryptoError):
            decrypt_password(cipher, key_version=version)


def test_missing_key_raises():
    with override_settings(
        OPERATOR_PASSWORD_ENCRYPTION_KEY="",
        OPERATOR_PASSWORD_ENCRYPTION_KEYS={},
    ):
        with pytest.raises(OperatorPasswordCryptoError):
            encrypt_password("whatever")

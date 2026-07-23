"""
FernetVault:
- encrypt returns (ciphertext, current_version)
- decrypt uses the pointed-to version and falls back to other keys on mismatch
- rotation v1 -> v2 keeps v1 rows decryptable but re-encrypts under v2

Uses ad-hoc vaults built with test-only settings attributes so the
project-wide operator_password_vault / tg_session_vault stay untouched.
"""

from __future__ import annotations

import pytest
from cryptography.fernet import Fernet
from django.test import override_settings

from apps.common.crypto import FernetVault, FernetVaultError


@pytest.fixture
def vault() -> FernetVault:
    return FernetVault(
        keys_setting_name="_TEST_FV_KEYS",
        current_version_setting_name="_TEST_FV_CURRENT_VERSION",
        purpose="test_vault",
    )


def _make_key() -> str:
    return Fernet.generate_key().decode("ascii")


def test_encrypt_returns_current_version(vault: FernetVault) -> None:
    k1 = _make_key()
    with override_settings(_TEST_FV_KEYS={"1": k1}, _TEST_FV_CURRENT_VERSION=1):
        cipher, version = vault.encrypt("hunter2")
        assert version == 1
        assert isinstance(cipher, bytes)
        assert cipher != b"hunter2"


def test_roundtrip_same_version(vault: FernetVault) -> None:
    k1 = _make_key()
    with override_settings(_TEST_FV_KEYS={"1": k1}, _TEST_FV_CURRENT_VERSION=1):
        cipher, version = vault.encrypt("Naff-3F9K2Q")
        assert vault.decrypt(cipher, version=version) == "Naff-3F9K2Q"


def test_key_rotation_v1_to_v2_roundtrip(vault: FernetVault) -> None:
    """Simulate: encrypt under v1, then rotate to v2 and confirm decrypt still works."""
    k1 = _make_key()
    k2 = _make_key()

    # Stage 1: everything on v1
    with override_settings(_TEST_FV_KEYS={"1": k1}, _TEST_FV_CURRENT_VERSION=1):
        cipher_v1, ver1 = vault.encrypt("plain-under-v1")
        assert ver1 == 1
        assert vault.decrypt(cipher_v1, version=1) == "plain-under-v1"

    # Stage 2: v2 introduced and made current; v1 still trusted for decrypt of
    # legacy rows. Verify decrypt works under old version *and* new writes
    # come out at v2.
    with override_settings(
        _TEST_FV_KEYS={"1": k1, "2": k2},
        _TEST_FV_CURRENT_VERSION=2,
    ):
        # Old row still decrypts using its stored version:
        assert vault.decrypt(cipher_v1, version=1) == "plain-under-v1"
        # New writes go to v2:
        cipher_v2, ver2 = vault.encrypt("plain-under-v2")
        assert ver2 == 2
        assert vault.decrypt(cipher_v2, version=2) == "plain-under-v2"

        # Rescue path: if we mis-recorded the version (e.g. a bug had us
        # writing '1' when we actually used v2), the vault should still
        # find the right key.
        assert vault.decrypt(cipher_v2, version=1) == "plain-under-v2"

        # Bulk rotation utility: re-encrypt a v1 row to v2.
        cipher_after, ver_after = vault.reencrypt(cipher_v1, from_version=1, to_version=2)
        assert ver_after == 2
        assert vault.decrypt(cipher_after, version=2) == "plain-under-v1"


def test_reencrypt_defaults_to_current(vault: FernetVault) -> None:
    k1 = _make_key()
    k2 = _make_key()
    with override_settings(_TEST_FV_KEYS={"1": k1}, _TEST_FV_CURRENT_VERSION=1):
        cipher_v1, ver1 = vault.encrypt("payload")
    with override_settings(
        _TEST_FV_KEYS={"1": k1, "2": k2},
        _TEST_FV_CURRENT_VERSION=2,
    ):
        cipher_new, new_version = vault.reencrypt(cipher_v1, from_version=ver1)
        assert new_version == 2
        assert vault.decrypt(cipher_new, version=2) == "payload"


def test_missing_keys_raises(vault: FernetVault) -> None:
    with override_settings(_TEST_FV_KEYS={}, _TEST_FV_CURRENT_VERSION=1):
        with pytest.raises(FernetVaultError):
            vault.encrypt("x")


def test_empty_plain_rejected(vault: FernetVault) -> None:
    k1 = _make_key()
    with override_settings(_TEST_FV_KEYS={"1": k1}, _TEST_FV_CURRENT_VERSION=1):
        with pytest.raises(FernetVaultError):
            vault.encrypt("")

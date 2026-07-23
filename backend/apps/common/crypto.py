"""
Versioned symmetric encryption helper used across the project.

Rationale
---------
Two independent secrets in the DB are encrypted with Fernet:
- ``users.OperatorSecret.encrypted_password``
- ``tg_userclient.TgSession.encrypted_session``

Historically each app carried its own tiny wrapper around
``cryptography.fernet.Fernet`` and hard-referenced a single settings key.
When we ever needed to rotate that key (compromised env file, personnel
rotation) every existing ciphertext would become undecryptable.

``FernetVault`` fixes both problems in one place:

- Accepts a *dict* of ``{version: key}`` so multiple keys can be
  simultaneously trusted for decrypt.
- Always encrypts with a single ``current_version`` — new writes are
  homogeneous, old rows remain decryptable until re-encrypted.
- Callers must persist the ``version`` used at encrypt time next to the
  ciphertext (see the ``key_version`` field on affected models) so
  decrypt can pick the right key.

The ``rotate_operator_secrets`` management command uses ``reencrypt``
to migrate rows from v1 → v2 in bulk.
"""

from __future__ import annotations

from typing import Mapping

from cryptography.fernet import Fernet, InvalidToken
from django.conf import settings


class FernetVaultError(RuntimeError):
    pass


class FernetVault:
    """
    Versioned Fernet wrapper.

    Parameters
    ----------
    keys_setting_name:
        Name of the settings attribute that holds the ``{version: key}`` dict.
        Version keys are stringified integers (``"1"``, ``"2"``, ...) so
        JSON-friendly env parsing keeps working.
    current_version_setting_name:
        Name of the settings attribute that holds the version used for
        *encrypt* operations. Must exist in ``keys_setting_name``.
    purpose:
        Free-text label used only in error messages so a misconfiguration
        error tells the operator *which* vault is broken.
    legacy_key_setting_name:
        Optional single-key backwards-compatible settings attribute. If
        provided and the versioned dict is empty, it becomes ``{"1": <key>}``
        with current_version=1. Lets us ship this refactor without a big
        environment migration.
    """

    def __init__(
        self,
        *,
        keys_setting_name: str,
        current_version_setting_name: str,
        purpose: str,
        legacy_key_setting_name: str | None = None,
    ) -> None:
        self.keys_setting_name = keys_setting_name
        self.current_version_setting_name = current_version_setting_name
        self.purpose = purpose
        self.legacy_key_setting_name = legacy_key_setting_name

    # ---- internal helpers -----------------------------------------------

    def _load_keys(self) -> dict[int, Fernet]:
        raw: Mapping[str, str] | None = getattr(settings, self.keys_setting_name, None) or None
        if not raw and self.legacy_key_setting_name:
            legacy = getattr(settings, self.legacy_key_setting_name, None)
            if legacy:
                raw = {"1": legacy}
        if not raw:
            raise FernetVaultError(
                f"{self.purpose}: no keys configured (set {self.keys_setting_name})"
            )
        keys: dict[int, Fernet] = {}
        for version_str, key in raw.items():
            try:
                version = int(version_str)
            except (TypeError, ValueError) as exc:
                raise FernetVaultError(
                    f"{self.purpose}: invalid key version '{version_str}'"
                ) from exc
            key_bytes = key.encode("utf-8") if isinstance(key, str) else bytes(key)
            try:
                keys[version] = Fernet(key_bytes)
            except (ValueError, TypeError) as exc:
                raise FernetVaultError(
                    f"{self.purpose}: malformed Fernet key for version {version}"
                ) from exc
        return keys

    def _current_version(self, keys: dict[int, Fernet]) -> int:
        version = getattr(settings, self.current_version_setting_name, None)
        if version is None:
            if self.legacy_key_setting_name and not getattr(
                settings, self.keys_setting_name, None
            ):
                return 1
            # Sensible default: highest configured version.
            return max(keys)
        try:
            return int(version)
        except (TypeError, ValueError) as exc:
            raise FernetVaultError(
                f"{self.purpose}: current version '{version}' is not an integer"
            ) from exc

    # ---- public API ------------------------------------------------------

    def encrypt(self, plain: str) -> tuple[bytes, int]:
        """
        Encrypt ``plain`` with the vault's current version.

        Returns ``(ciphertext, version)`` — caller MUST persist both next
        to each other. Empty inputs are rejected because there is never a
        legitimate reason to store an empty ciphertext.
        """
        if not isinstance(plain, str) or not plain:
            raise FernetVaultError(f"{self.purpose}: cannot encrypt empty value")
        keys = self._load_keys()
        version = self._current_version(keys)
        fernet = keys.get(version)
        if fernet is None:
            raise FernetVaultError(
                f"{self.purpose}: current version {version} missing from keys dict"
            )
        return fernet.encrypt(plain.encode("utf-8")), version

    def decrypt(self, ciphertext: bytes | memoryview, *, version: int) -> str:
        """
        Decrypt using the key registered for ``version``. Falls back to
        trying every configured key if the pointed-to one fails — this
        rescues rows whose stored ``key_version`` got mangled during a
        botched rotation.
        """
        if ciphertext is None or ciphertext == b"":
            raise FernetVaultError(f"{self.purpose}: empty ciphertext")
        raw = bytes(ciphertext)
        keys = self._load_keys()
        fernet = keys.get(version)
        if fernet is not None:
            try:
                return fernet.decrypt(raw).decode("utf-8")
            except InvalidToken:
                pass
        # Rescue: try every key. Deterministic order — highest version first.
        for other_version in sorted(keys.keys(), reverse=True):
            if other_version == version:
                continue
            try:
                return keys[other_version].decrypt(raw).decode("utf-8")
            except InvalidToken:
                continue
        raise FernetVaultError(
            f"{self.purpose}: ciphertext is not decryptable with any configured key "
            f"(pointed version={version})"
        )

    def reencrypt(
        self,
        ciphertext: bytes | memoryview,
        *,
        from_version: int,
        to_version: int | None = None,
    ) -> tuple[bytes, int]:
        """
        Decrypt with ``from_version`` (with rescue) and re-encrypt under
        ``to_version`` (defaults to the vault's current version). Idempotent
        if from_version == target version.
        """
        keys = self._load_keys()
        target = to_version if to_version is not None else self._current_version(keys)
        plain = self.decrypt(ciphertext, version=from_version)
        fernet = keys.get(target)
        if fernet is None:
            raise FernetVaultError(
                f"{self.purpose}: target version {target} missing from keys dict"
            )
        return fernet.encrypt(plain.encode("utf-8")), target


# ---- Concrete vaults -----------------------------------------------------

operator_password_vault = FernetVault(
    keys_setting_name="OPERATOR_PASSWORD_ENCRYPTION_KEYS",
    current_version_setting_name="OPERATOR_PASSWORD_ENCRYPTION_CURRENT_VERSION",
    purpose="operator_password",
    legacy_key_setting_name="OPERATOR_PASSWORD_ENCRYPTION_KEY",
)

tg_session_vault = FernetVault(
    keys_setting_name="TG_SESSION_ENCRYPTION_KEYS",
    current_version_setting_name="TG_SESSION_ENCRYPTION_CURRENT_VERSION",
    purpose="tg_session",
    legacy_key_setting_name="TG_SESSION_ENCRYPTION_KEY",
)


__all__ = [
    "FernetVault",
    "FernetVaultError",
    "operator_password_vault",
    "tg_session_vault",
]

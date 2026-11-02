"""
Meta Ads: подключение токена, список рекламных аккаунтов, назначение SMM.

Токен проверяется живым запросом к Graph API (`/me`, `/me/adaccounts`) до
сохранения и хранится только зашифрованным (`meta_token_vault`). Наружу
(API, логи, аудит) токен не отдаётся никогда.
"""

from __future__ import annotations

import datetime as dt

from django.contrib.auth import get_user_model
from django.db import transaction
from django.utils import timezone

from apps.audit.models import AuditAction
from apps.audit.services import audit_log_create
from apps.common.crypto import FernetVaultError, meta_token_vault
from apps.users.models import Role

from .integrations.meta.client import MetaApiError, MetaClient
from .integrations.meta.leads import meta_page_ensure_source, meta_page_leads_sync
from .integrations.meta.sync import meta_account_sync, meta_token_decrypt
from .models import MetaAdAccount, MetaConnection, MetaPage

User = get_user_model()

_UNSET = object()


def _encrypt_token(token: str) -> tuple[bytes, int]:
    try:
        return meta_token_vault.encrypt(token)
    except FernetVaultError as exc:
        raise ValueError(
            "На сервере не задан META_TOKEN_ENCRYPTION_KEY — токен Meta негде хранить."
        ) from exc


def _token_expiry(client: MetaClient) -> dt.datetime | None:
    try:
        info = client.token_info()
    except MetaApiError:
        return None
    try:
        exp = int(info.get("expires_at") or 0)
    except (TypeError, ValueError):
        return None
    if exp <= 0:
        return None
    return dt.datetime.fromtimestamp(exp, tz=dt.UTC)


def meta_accounts_refresh(conn: MetaConnection, client: MetaClient) -> list[MetaAdAccount]:
    """Upsert всех аккаунтов, которые видит токен. smm / is_active не трогаем."""
    out: list[MetaAdAccount] = []
    for row in client.ad_accounts():
        account_id = str(row.get("id") or "")
        if not account_id:
            continue
        if not account_id.startswith("act_"):
            account_id = f"act_{account_id}"
        acc, _ = MetaAdAccount.objects.update_or_create(
            account_id=account_id,
            defaults={
                "connection": conn,
                "name": str(row.get("name") or "")[:255],
                "currency": str(row.get("currency") or "USD")[:8],
                "timezone_name": str(row.get("timezone_name") or "")[:64],
                "account_status": row.get("account_status"),
            },
        )
        out.append(acc)
    return out


def meta_pages_refresh(conn: MetaConnection, client: MetaClient) -> list[MetaPage]:
    """Upsert страниц, которые видит токен. smm / leads_enabled не трогаем."""
    out: list[MetaPage] = []
    for row in client.pages():
        page_id = str(row.get("id") or "")
        if not page_id:
            continue
        page, _ = MetaPage.objects.update_or_create(
            page_id=page_id,
            defaults={
                "connection": conn,
                "name": str(row.get("name") or "")[:255],
                "tasks": [str(t) for t in (row.get("tasks") or [])][:20],
            },
        )
        out.append(page)
    return out


def _check_with_client(conn: MetaConnection, client: MetaClient) -> MetaConnection:
    me = client.me()
    conn.meta_user_id = str(me.get("id") or "")[:64]
    conn.meta_user_name = str(me.get("name") or "")[:255]
    conn.token_expires_at = _token_expiry(client)
    conn.last_checked_at = timezone.now()
    conn.last_error = ""
    meta_accounts_refresh(conn, client)
    try:
        meta_pages_refresh(conn, client)
    except MetaApiError as exc:
        # Без pages_show_list статистика рекламы всё равно работает.
        conn.last_error = f"Страницы Facebook недоступны: {exc}"[:2000]
    return conn


def meta_connection_create(
    *, token: str, name: str = "", user=None, client: MetaClient | None = None
) -> MetaConnection:
    token = (token or "").strip()
    if not token:
        raise ValueError("Вставьте токен Meta.")
    ciphertext, version = _encrypt_token(token)
    own = client is None
    client = client or MetaClient(token)
    try:
        try:
            me = client.me()
        except MetaApiError as exc:
            raise ValueError(f"Meta не приняла токен: {exc.message}") from exc
        with transaction.atomic():
            conn = MetaConnection.objects.create(
                name=(name or str(me.get("name") or ""))[:128],
                token_ciphertext=ciphertext,
                token_key_version=version,
                created_by=user if getattr(user, "is_authenticated", False) else None,
            )
            try:
                _check_with_client(conn, client)
            except MetaApiError as exc:
                conn.last_error = str(exc)[:2000]
                conn.last_checked_at = timezone.now()
            conn.save()
    finally:
        if own:
            client.close()
    audit_log_create(
        user=user,
        action=AuditAction.CREATE,
        entity="meta_connection",
        entity_id=conn.id,
        changes={"meta_user": conn.meta_user_name, "accounts": conn.ad_accounts.count()},
    )
    return conn


def meta_connection_check(conn: MetaConnection, *, client: MetaClient | None = None) -> MetaConnection:
    own = client is None
    try:
        client = client or MetaClient(meta_token_decrypt(conn))
    except FernetVaultError as exc:
        conn.last_error = f"токен не расшифровывается: {exc}"[:2000]
        conn.save(update_fields=["last_error", "updated_at"])
        return conn
    try:
        _check_with_client(conn, client)
    except MetaApiError as exc:
        conn.last_error = str(exc)[:2000]
        conn.last_checked_at = timezone.now()
    finally:
        if own:
            client.close()
    conn.save()
    return conn


def meta_connection_replace_token(
    conn: MetaConnection, *, token: str, user=None, client: MetaClient | None = None
) -> MetaConnection:
    token = (token or "").strip()
    if not token:
        raise ValueError("Вставьте токен Meta.")
    ciphertext, version = _encrypt_token(token)
    own = client is None
    client = client or MetaClient(token)
    try:
        try:
            client.me()
        except MetaApiError as exc:
            raise ValueError(f"Meta не приняла токен: {exc.message}") from exc
        conn.token_ciphertext = ciphertext
        conn.token_key_version = version
        try:
            _check_with_client(conn, client)
        except MetaApiError as exc:
            conn.last_error = str(exc)[:2000]
        conn.save()
    finally:
        if own:
            client.close()
    audit_log_create(
        user=user,
        action=AuditAction.UPDATE,
        entity="meta_connection",
        entity_id=conn.id,
        changes={"token": "replaced"},
    )
    return conn


def meta_connection_delete(conn: MetaConnection, *, user=None) -> None:
    conn_id = conn.id
    accounts = list(conn.ad_accounts.values_list("account_id", flat=True))
    conn.delete()
    audit_log_create(
        user=user,
        action=AuditAction.DELETE,
        entity="meta_connection",
        entity_id=conn_id,
        changes={"accounts": accounts},
    )


def _resolve_smm(smm_id) -> User | None:
    if smm_id in (None, "", 0):
        return None
    try:
        return User.objects.get(pk=int(smm_id), profile__role=Role.SMM)
    except (User.DoesNotExist, TypeError, ValueError) as exc:
        raise ValueError("Пользователь не найден или у него не роль SMM.") from exc


def meta_ad_account_update(
    account: MetaAdAccount, *, smm_id=_UNSET, is_active=None, user=None
) -> MetaAdAccount:
    changes: dict = {}
    if smm_id is not _UNSET:
        smm = _resolve_smm(smm_id)
        changes["smm"] = {"old": account.smm_id, "new": smm.id if smm else None}
        account.smm = smm
    if is_active is not None:
        changes["is_active"] = {"old": account.is_active, "new": bool(is_active)}
        account.is_active = bool(is_active)
    account.save()
    audit_log_create(
        user=user,
        action=AuditAction.UPDATE,
        entity="meta_ad_account",
        entity_id=account.id,
        changes=changes,
    )
    return account


def meta_ad_account_sync_now(account: MetaAdAccount, *, days: int | None = None) -> dict:
    return meta_account_sync(account, days=days)


def meta_page_update(
    page: MetaPage,
    *,
    smm_id=_UNSET,
    leads_enabled: bool | None = None,
    backfill_hours: int = 0,
    user=None,
) -> MetaPage:
    """
    Назначить страницу SMM и/или включить забор заявок. При включении
    заявки берутся начиная с «сейчас − backfill_hours» (0..168), чтобы
    операторам не прилетела разом вся история формы.
    """
    changes: dict = {}
    if smm_id is not _UNSET:
        smm = _resolve_smm(smm_id)
        changes["smm"] = {"old": page.smm_id, "new": smm.id if smm else None}
        page.smm = smm
    if leads_enabled is not None and bool(leads_enabled) != page.leads_enabled:
        changes["leads_enabled"] = {"old": page.leads_enabled, "new": bool(leads_enabled)}
        page.leads_enabled = bool(leads_enabled)
        if page.leads_enabled:
            hours = max(0, min(int(backfill_hours or 0), 168))
            page.leads_since = timezone.now() - dt.timedelta(hours=hours)
            changes["leads_since"] = page.leads_since.isoformat()
    page.save()
    if page.leads_enabled or page.source_id:
        meta_page_ensure_source(page, user=user)
    audit_log_create(
        user=user,
        action=AuditAction.UPDATE,
        entity="meta_page",
        entity_id=page.id,
        changes=changes,
    )
    return page


def meta_page_sync_now(page: MetaPage) -> dict:
    return meta_page_leads_sync(page)


__all__ = [
    "meta_accounts_refresh",
    "meta_ad_account_sync_now",
    "meta_ad_account_update",
    "meta_connection_check",
    "meta_connection_create",
    "meta_connection_delete",
    "meta_connection_replace_token",
    "meta_page_sync_now",
    "meta_page_update",
    "meta_pages_refresh",
]

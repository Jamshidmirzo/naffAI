"""
Синхронизация статистики Meta Ads в БД.

`meta_account_sync(account)`:
  1. объявления + креативы (`/act_X/ads`) → `MetaAd`;
  2. Insights по дням на уровне объявления → `MetaAdInsightDaily` (upsert по
     account+ad+date; строки окна, которых Meta больше не отдаёт, удаляются —
     так подхватываются задним числом исправленные расходы);
  3. курс ЦБ на эти дни → `FxRate`.
Первый запуск тянет 90 дней, дальше — скользящие 7 (Meta дописывает
конверсии и расход за прошлые дни).
"""

from __future__ import annotations

import datetime as dt
import logging
from collections.abc import Iterable
from decimal import Decimal, InvalidOperation
from typing import Any

from django.db import transaction
from django.utils import timezone

from apps.common.crypto import meta_token_vault
from apps.marketing.models import MetaAd, MetaAdAccount, MetaAdInsightDaily, MetaConnection

from .client import MetaApiError, MetaClient
from .fx import Fetcher, fx_rates_ensure

logger = logging.getLogger("apps.marketing.meta")

INITIAL_DAYS = 90
ROLLING_DAYS = 7
CHUNK_DAYS = 15

# `lead` — агрегат Meta по всем лидам (формы + пиксель); остальные — запасные
# варианты, если агрегата в ответе нет.
LEAD_ACTION_TYPES = ("lead", "onsite_conversion.lead_grouped", "leadgen_grouped")


# ---- token ----------------------------------------------------------------


def meta_token_decrypt(conn: MetaConnection) -> str:
    return meta_token_vault.decrypt(bytes(conn.token_ciphertext), version=conn.token_key_version)


def client_for_connection(conn: MetaConnection, **kwargs) -> MetaClient:
    return MetaClient(meta_token_decrypt(conn), **kwargs)


# ---- parsing --------------------------------------------------------------


def _int(v: Any) -> int:
    try:
        return int(Decimal(str(v)))
    except (InvalidOperation, TypeError, ValueError):
        return 0


def _dec(v: Any) -> Decimal:
    try:
        return Decimal(str(v))
    except (InvalidOperation, TypeError, ValueError):
        return Decimal("0")


def _action(actions: Any, types: Iterable[str]) -> int:
    by_type = {
        str(a.get("action_type")): a.get("value")
        for a in actions or []
        if isinstance(a, dict)
    }
    for t in types:
        if t in by_type:
            return _int(by_type[t])
    return 0


def _sum_actions(actions: Any) -> Decimal:
    return sum((_dec(a.get("value")) for a in actions or [] if isinstance(a, dict)), Decimal("0"))


def parse_insight_row(row: dict) -> dict:
    actions = row.get("actions")
    return {
        "date": dt.date.fromisoformat(str(row["date_start"])[:10]),
        "ad_id": str(row.get("ad_id") or ""),
        "ad_name": str(row.get("ad_name") or "")[:512],
        "campaign_id": str(row.get("campaign_id") or ""),
        "campaign_name": str(row.get("campaign_name") or "")[:512],
        "adset_id": str(row.get("adset_id") or ""),
        "adset_name": str(row.get("adset_name") or "")[:512],
        "spend": _dec(row.get("spend")),
        "impressions": _int(row.get("impressions")),
        "reach": _int(row.get("reach")),
        "clicks": _int(row.get("clicks")),
        "link_clicks": _int(row.get("inline_link_clicks")),
        "meta_leads": _action(actions, LEAD_ACTION_TYPES),
        "video_3s": _action(actions, ("video_view",)),
        "thruplays": _int(_sum_actions(row.get("video_thruplay_watched_actions"))),
        "video_p25": _int(_sum_actions(row.get("video_p25_watched_actions"))),
        "video_p50": _int(_sum_actions(row.get("video_p50_watched_actions"))),
        "video_p75": _int(_sum_actions(row.get("video_p75_watched_actions"))),
        "video_p100": _int(_sum_actions(row.get("video_p100_watched_actions"))),
        "video_avg_watch_sec": _sum_actions(row.get("video_avg_time_watched_actions")),
    }


def parse_ad(row: dict) -> dict:
    creative = row.get("creative") or {}
    story = creative.get("object_story_spec") or {}
    video_data = story.get("video_data") or {}
    link_data = story.get("link_data") or {}
    return {
        "name": str(row.get("name") or "")[:512],
        "status": str(row.get("effective_status") or "")[:32],
        "campaign_id": str(row.get("campaign_id") or ""),
        "campaign_name": str((row.get("campaign") or {}).get("name") or "")[:512],
        "adset_id": str(row.get("adset_id") or ""),
        "adset_name": str((row.get("adset") or {}).get("name") or "")[:512],
        "creative_id": str(creative.get("id") or ""),
        "thumbnail_url": str(creative.get("thumbnail_url") or ""),
        "image_url": str(
            creative.get("image_url") or video_data.get("image_url") or link_data.get("picture") or ""
        ),
        "video_id": str(creative.get("video_id") or video_data.get("video_id") or ""),
        "preview_url": str(row.get("preview_shareable_link") or ""),
    }


# ---- upserts --------------------------------------------------------------


def meta_ads_upsert(account: MetaAdAccount, client: MetaClient) -> int:
    n = 0
    for row in client.ads(account.account_id):
        ad_id = str(row.get("id") or "")
        if not ad_id:
            continue
        MetaAd.objects.update_or_create(
            ad_id=ad_id, defaults={"ad_account": account, **parse_ad(row)}
        )
        n += 1
    return n


def _windows(since: dt.date, until: dt.date) -> Iterable[tuple[dt.date, dt.date]]:
    cur = since
    while cur <= until:
        end = min(until, cur + dt.timedelta(days=CHUNK_DAYS - 1))
        yield cur, end
        cur = end + dt.timedelta(days=1)


def meta_insights_upsert(
    account: MetaAdAccount, client: MetaClient, since: dt.date, until: dt.date
) -> int:
    written = 0
    for w_since, w_until in _windows(since, until):
        rows = [parse_insight_row(r) for r in client.insights(account.account_id, w_since, w_until)]
        rows = [r for r in rows if r["ad_id"]]
        with transaction.atomic():
            seen: set[tuple[str, dt.date]] = set()
            for r in rows:
                key = (r["ad_id"], r["date"])
                seen.add(key)
                fields = {k: v for k, v in r.items() if k not in ("ad_id", "date")}
                MetaAdInsightDaily.objects.update_or_create(
                    ad_account=account,
                    ad_id=r["ad_id"],
                    date=r["date"],
                    defaults={**fields, "currency": account.currency or "USD"},
                )
                written += 1
            stale = MetaAdInsightDaily.objects.filter(
                ad_account=account, date__gte=w_since, date__lte=w_until
            )
            stale_ids = [
                pk for pk, ad_id, day in stale.values_list("id", "ad_id", "date")
                if (ad_id, day) not in seen
            ]
            if stale_ids:
                MetaAdInsightDaily.objects.filter(id__in=stale_ids).delete()
            _ensure_ads_from_insights(account, rows)
    return written


def _ensure_ads_from_insights(account: MetaAdAccount, rows: list[dict]) -> None:
    """Удалённые/архивные объявления не приходят из /ads, но есть в Insights."""
    known = set(
        MetaAd.objects.filter(ad_id__in={r["ad_id"] for r in rows}).values_list("ad_id", flat=True)
    )
    for r in rows:
        if r["ad_id"] in known:
            continue
        MetaAd.objects.create(
            ad_account=account,
            ad_id=r["ad_id"],
            name=r["ad_name"],
            campaign_id=r["campaign_id"],
            campaign_name=r["campaign_name"],
            adset_id=r["adset_id"],
            adset_name=r["adset_name"],
        )
        known.add(r["ad_id"])


# ---- entry point ----------------------------------------------------------


def meta_account_sync(
    account: MetaAdAccount,
    *,
    days: int | None = None,
    client: MetaClient | None = None,
    today: dt.date | None = None,
    fx_fetch: Fetcher | None = None,
) -> dict:
    today = today or timezone.localdate()
    if days is None:
        days = ROLLING_DAYS if account.synced_since else INITIAL_DAYS
    since = today - dt.timedelta(days=max(1, days) - 1)
    own_client = client is None
    try:
        client = client or client_for_connection(account.connection)
        ads = meta_ads_upsert(account, client)
        rows = meta_insights_upsert(account, client, since, today)
    except MetaApiError as exc:
        account.last_sync_error = str(exc)[:2000]
        account.save(update_fields=["last_sync_error", "updated_at"])
        if exc.is_auth_error:
            conn = account.connection
            conn.last_error = str(exc)[:2000]
            conn.save(update_fields=["last_error", "updated_at"])
        raise
    finally:
        if own_client and client is not None:
            client.close()

    days_range = [since + dt.timedelta(days=i) for i in range((today - since).days + 1)]
    fx_rates_ensure(account.currency or "USD", days_range, fetch=fx_fetch)

    account.last_synced_at = timezone.now()
    account.last_sync_error = ""
    if account.synced_since is None or since < account.synced_since:
        account.synced_since = since
    account.save(update_fields=["last_synced_at", "last_sync_error", "synced_since", "updated_at"])
    logger.info("meta sync %s: ads=%s rows=%s %s..%s", account.account_id, ads, rows, since, today)
    return {"ads": ads, "insight_rows": rows, "since": since.isoformat(), "until": today.isoformat()}


def meta_sync_all(*, days: int | None = None, fx_fetch: Fetcher | None = None) -> list[dict]:
    """Все включённые аккаунты. Ошибка одного не мешает остальным."""
    out: list[dict] = []
    qs = MetaAdAccount.objects.filter(is_active=True).select_related("connection")
    for account in qs:
        try:
            res = meta_account_sync(account, days=days, fx_fetch=fx_fetch)
            out.append({"account": account.account_id, "ok": True, **res})
        except MetaApiError as exc:
            logger.warning("meta sync %s failed: %s", account.account_id, exc)
            out.append({"account": account.account_id, "ok": False, "error": str(exc)})
        except Exception as exc:
            logger.exception("meta sync %s crashed", account.account_id)
            account.last_sync_error = f"внутренняя ошибка: {exc}"[:2000]
            account.save(update_fields=["last_sync_error", "updated_at"])
            out.append({"account": account.account_id, "ok": False, "error": str(exc)})
    return out


__all__ = [
    "client_for_connection",
    "meta_account_sync",
    "meta_ads_upsert",
    "meta_insights_upsert",
    "meta_sync_all",
    "meta_token_decrypt",
    "parse_ad",
    "parse_insight_row",
]

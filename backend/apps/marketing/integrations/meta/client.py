"""
Graph API client for the Marketing API (read-only, `ads_read`).

Docs: https://developers.facebook.com/docs/marketing-api/insights
Version comes from `settings.META_GRAPH_VERSION` (v26.0 at the time of
writing); Meta keeps a version alive for two years after the next one ships.

Only GETs. Errors come back as `{"error": {"message", "type", "code",
"error_subcode", "fbtrace_id"}}`; we raise `MetaApiError` and retry the
throttling / transient ones (HTTP 429/5xx, codes 1, 2, 4, 17, 32, 341, 613,
80000-80014).
"""

from __future__ import annotations

import datetime as dt
import json
import logging
import time
from collections.abc import Callable, Iterator
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import httpx
from django.conf import settings

logger = logging.getLogger("apps.marketing.meta")

GRAPH_HOST = "https://graph.facebook.com"

# Codes Meta documents as "try again later" (rate limits, transient).
_RETRY_CODES = {1, 2, 4, 17, 32, 341, 613}
_AUTH_CODES = {102, 190, 200, 10}

INSIGHT_FIELDS = (
    "date_start",
    "campaign_id",
    "campaign_name",
    "adset_id",
    "adset_name",
    "ad_id",
    "ad_name",
    "spend",
    "impressions",
    "reach",
    "clicks",
    "inline_link_clicks",
    "actions",
    "video_p25_watched_actions",
    "video_p50_watched_actions",
    "video_p75_watched_actions",
    "video_p100_watched_actions",
    "video_thruplay_watched_actions",
    "video_avg_time_watched_actions",
)

AD_FIELDS = (
    "id",
    "name",
    "effective_status",
    "campaign_id",
    "campaign{name}",
    "adset_id",
    "adset{name}",
    "creative{id,thumbnail_url,image_url,video_id,object_story_spec}",
    "preview_shareable_link",
)

AD_ACCOUNT_FIELDS = ("id", "account_id", "name", "currency", "timezone_name", "account_status")

# Lead Ads retrieval (page token + leads_retrieval / pages_manage_ads / pages_show_list).
LEAD_FIELDS = (
    "id",
    "created_time",
    "ad_id",
    "ad_name",
    "adset_id",
    "adset_name",
    "campaign_id",
    "campaign_name",
    "form_id",
    "field_data",
    "is_organic",
    "platform",
)


class MetaApiError(Exception):
    def __init__(
        self,
        message: str,
        *,
        code: int | None = None,
        subcode: int | None = None,
        http_status: int | None = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.code = code
        self.subcode = subcode
        self.http_status = http_status

    @property
    def is_auth_error(self) -> bool:
        return self.code in _AUTH_CODES or self.http_status == 401

    @property
    def is_retryable(self) -> bool:
        if self.http_status is not None and (self.http_status == 429 or self.http_status >= 500):
            return True
        if self.code is None:
            return False
        return self.code in _RETRY_CODES or 80000 <= self.code <= 80014

    def __str__(self) -> str:
        if self.code is not None:
            return f"Meta API #{self.code}: {self.message}"
        return f"Meta API: {self.message}"


class MetaClient:
    """
    `transport` / `sleep` are injectable so tests run against
    `httpx.MockTransport` without real network or real waits.
    """

    def __init__(
        self,
        token: str,
        *,
        version: str | None = None,
        timeout: float | None = None,
        transport: httpx.BaseTransport | None = None,
        sleep: Callable[[float], None] = time.sleep,
        max_retries: int = 3,
    ) -> None:
        if not token:
            raise MetaApiError("пустой токен")
        self.token = token
        self.version = version or settings.META_GRAPH_VERSION
        self._sleep = sleep
        self._max_retries = max_retries
        self._transport = transport
        self._timeout = timeout
        self._http = httpx.Client(
            timeout=timeout or settings.META_GRAPH_TIMEOUT_SECONDS,
            transport=transport,
        )

    def with_token(self, token: str) -> MetaClient:
        """Same settings, another token (page access token for lead forms)."""
        return MetaClient(
            token,
            version=self.version,
            timeout=self._timeout,
            transport=self._transport,
            sleep=self._sleep,
            max_retries=self._max_retries,
        )

    def close(self) -> None:
        self._http.close()

    def __enter__(self) -> MetaClient:
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    # ---- low level ------------------------------------------------------

    def _url(self, path: str) -> str:
        return f"{GRAPH_HOST}/{self.version}/{path.lstrip('/')}"

    def _get(self, url: str, params: dict | None = None) -> dict:
        query = dict(params or {})
        # Токен — только заголовком: URL попадает в логи (httpx INFO, nginx).
        # `paging.next` от Meta несёт access_token в query — вырезаем.
        url = _strip_token(url)
        headers = {"Authorization": f"Bearer {self.token}"}
        attempt = 0
        while True:
            attempt += 1
            try:
                resp = self._http.get(url, params=query or None, headers=headers)
            except httpx.HTTPError as exc:
                err = MetaApiError(f"сеть: {exc}", http_status=599)
            else:
                err = _error_from_response(resp)
                if err is None:
                    return resp.json()
            if not err.is_retryable or attempt > self._max_retries:
                raise err
            delay = min(60, 2 ** attempt * 2)
            logger.warning("meta: %s — retry %s in %ss", err, attempt, delay)
            self._sleep(delay)

    def _paged(self, path: str, params: dict) -> Iterator[dict]:
        url = self._url(path)
        query: dict | None = params
        while url:
            body = self._get(url, query)
            yield from body.get("data") or []
            url = ((body.get("paging") or {}).get("next")) or ""
            query = None

    # ---- endpoints ------------------------------------------------------

    def me(self) -> dict:
        return self._get(self._url("me"), {"fields": "id,name"})

    def ad_accounts(self) -> list[dict]:
        return list(
            self._paged(
                "me/adaccounts", {"fields": ",".join(AD_ACCOUNT_FIELDS), "limit": 200}
            )
        )

    def token_info(self) -> dict:
        """
        `debug_token` on the token itself. Returns `{"expires_at": int,
        "is_valid": bool, "scopes": [...], "type": "USER"|"SYSTEM_USER"}`;
        `expires_at == 0` = never expires. Some token kinds can't introspect
        themselves — callers treat errors as "unknown expiry".
        """
        body = self._get(self._url("debug_token"), {"input_token": self.token})
        return body.get("data") or {}

    def insights(self, account_id: str, since: dt.date, until: dt.date) -> Iterator[dict]:
        params = {
            "level": "ad",
            "time_increment": 1,
            "time_range": json.dumps(
                {"since": since.isoformat(), "until": until.isoformat()}
            ),
            "fields": ",".join(INSIGHT_FIELDS),
            "action_breakdowns": "action_type",
            "limit": 500,
        }
        yield from self._paged(f"{_act(account_id)}/insights", params)

    def ads(self, account_id: str) -> Iterator[dict]:
        params = {"fields": ",".join(AD_FIELDS), "limit": 200}
        yield from self._paged(f"{_act(account_id)}/ads", params)

    # ---- Lead Ads -------------------------------------------------------

    def pages(self) -> list[dict]:
        """Pages the token can act on, each with its own page access token."""
        return list(
            self._paged("me/accounts", {"fields": "id,name,tasks,access_token", "limit": 100})
        )

    def page_token(self, page_id: str) -> str:
        body = self._get(self._url(str(page_id)), {"fields": "access_token"})
        return str(body.get("access_token") or "")

    def lead_forms(self, page_id: str) -> list[dict]:
        """Needs a page access token (see `with_token`)."""
        return list(
            self._paged(
                f"{page_id}/leadgen_forms", {"fields": "id,name,status,created_time", "limit": 100}
            )
        )

    def form_leads(self, form_id: str, since: dt.datetime | None = None) -> Iterator[dict]:
        """Leads of a form created after `since` (Meta keeps them ~90 days)."""
        params: dict = {"fields": ",".join(LEAD_FIELDS), "limit": 100}
        if since is not None:
            params["filtering"] = json.dumps(
                [{"field": "time_created", "operator": "GREATER_THAN", "value": int(since.timestamp())}]
            )
        yield from self._paged(f"{form_id}/leads", params)


def _strip_token(url: str) -> str:
    if "access_token=" not in url:
        return url
    parts = urlsplit(url)
    query = [(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True) if k != "access_token"]
    return urlunsplit(parts._replace(query=urlencode(query)))


def _act(account_id: str) -> str:
    account_id = str(account_id)
    return account_id if account_id.startswith("act_") else f"act_{account_id}"


def _error_from_response(resp: httpx.Response) -> MetaApiError | None:
    if resp.status_code < 400:
        try:
            body = resp.json()
        except ValueError:
            return MetaApiError("ответ не JSON", http_status=resp.status_code)
        if isinstance(body, dict) and "error" in body:
            return _error_from_body(body, resp.status_code)
        return None
    try:
        body = resp.json()
    except ValueError:
        return MetaApiError(
            f"HTTP {resp.status_code}: {resp.text[:200]}", http_status=resp.status_code
        )
    return _error_from_body(body, resp.status_code)


def _error_from_body(body: Any, http_status: int) -> MetaApiError:
    err = (body or {}).get("error") if isinstance(body, dict) else None
    if not isinstance(err, dict):
        return MetaApiError(f"HTTP {http_status}", http_status=http_status)
    return MetaApiError(
        str(err.get("error_user_msg") or err.get("message") or "unknown error"),
        code=_int_or_none(err.get("code")),
        subcode=_int_or_none(err.get("error_subcode")),
        http_status=http_status,
    )


def _int_or_none(v: Any) -> int | None:
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


__all__ = ["MetaApiError", "MetaClient"]

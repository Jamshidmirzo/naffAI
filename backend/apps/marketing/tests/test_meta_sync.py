"""
Meta Marketing API: клиент (пагинация, ошибки, ретраи), синк, подключение токена.
Сеть не трогаем — httpx.MockTransport отвечает как Graph API.
"""

from __future__ import annotations

import datetime as dt
import json
from decimal import Decimal
from urllib.parse import parse_qs, urlparse

import httpx
import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from apps.common.crypto import meta_token_vault
from apps.marketing.integrations.meta.client import MetaApiError, MetaClient
from apps.marketing.integrations.meta.sync import meta_account_sync, parse_insight_row
from apps.marketing.meta_services import meta_connection_create
from apps.marketing.models import FxRate, MetaAd, MetaAdAccount, MetaAdInsightDaily, MetaConnection
from apps.users.models import Profile, Role

User = get_user_model()
TODAY = dt.date(2026, 11, 1)

INSIGHT_ROW = {
    "date_start": "2026-11-01",
    "date_stop": "2026-11-01",
    "campaign_id": "c1",
    "campaign_name": "Noyabr",
    "adset_id": "s1",
    "adset_name": "Toshkent 18-35",
    "ad_id": "120249319606330361",
    "ad_name": "Video 1",
    "spend": "12.34",
    "impressions": "5000",
    "reach": "4100",
    "clicks": "150",
    "inline_link_clicks": "120",
    "actions": [
        {"action_type": "video_view", "value": "900"},
        {"action_type": "onsite_conversion.lead_grouped", "value": "7"},
        {"action_type": "lead", "value": "7"},
        {"action_type": "link_click", "value": "120"},
    ],
    "video_p25_watched_actions": [{"action_type": "video_view", "value": "600"}],
    "video_p50_watched_actions": [{"action_type": "video_view", "value": "400"}],
    "video_p75_watched_actions": [{"action_type": "video_view", "value": "250"}],
    "video_p100_watched_actions": [{"action_type": "video_view", "value": "100"}],
    "video_thruplay_watched_actions": [{"action_type": "video_view", "value": "180"}],
    "video_avg_time_watched_actions": [{"action_type": "video_view", "value": "6.4"}],
}

AD_ROW = {
    "id": "120249319606330361",
    "name": "Video 1",
    "effective_status": "ACTIVE",
    "campaign_id": "c1",
    "campaign": {"name": "Noyabr", "id": "c1"},
    "adset_id": "s1",
    "adset": {"name": "Toshkent 18-35", "id": "s1"},
    "creative": {
        "id": "cr1",
        "thumbnail_url": "https://scontent/thumb.jpg",
        "object_story_spec": {"video_data": {"video_id": "v99", "image_url": "https://img"}},
    },
    "preview_shareable_link": "https://fb.me/adspreview/abc",
}


class FakeGraph:
    """Маршрутизатор MockTransport: путь → функция(request) → (status, json)."""

    def __init__(self):
        self.calls: list[httpx.Request] = []
        self.insights_pages = [[INSIGHT_ROW]]
        self.ads_rows = [AD_ROW]
        self.fail_once: dict[str, tuple[int, dict]] = {}

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.calls.append(request)
        path = request.url.path
        if path in self.fail_once:
            status, body = self.fail_once.pop(path)
            return httpx.Response(status, json=body)
        q = parse_qs(urlparse(str(request.url)).query)
        if path.endswith("/me"):
            return httpx.Response(200, json={"id": "42", "name": "Owner System User"})
        if path.endswith("/debug_token"):
            return httpx.Response(200, json={"data": {"is_valid": True, "expires_at": 0}})
        if path.endswith("/me/adaccounts"):
            return httpx.Response(200, json={"data": [
                {"id": "act_111", "account_id": "111", "name": "Sarvar Ads", "currency": "USD",
                 "timezone_name": "Asia/Tashkent", "account_status": 1},
                {"id": "act_222", "account_id": "222", "name": "Bekzod Ads", "currency": "USD",
                 "timezone_name": "Asia/Tashkent", "account_status": 1},
            ]})
        if path.endswith("/ads"):
            return httpx.Response(200, json={"data": self.ads_rows})
        if path.endswith("/insights"):
            page = int((q.get("page") or ["0"])[0])
            rows = self.insights_pages[page] if page < len(self.insights_pages) else []
            body: dict = {"data": rows}
            if page + 1 < len(self.insights_pages):
                nxt = request.url.copy_merge_params({"page": str(page + 1)})
                body["paging"] = {"next": str(nxt)}
            return httpx.Response(200, json=body)
        return httpx.Response(404, json={"error": {"message": "unknown path", "code": 100}})


def _client(graph: FakeGraph, token="EAAtoken") -> MetaClient:
    return MetaClient(token, transport=httpx.MockTransport(graph), sleep=lambda s: None)


@pytest.fixture
def smm(db):
    u = User.objects.create_user(username="smm", password="x")
    Profile.objects.create(user=u, role=Role.SMM)
    return u


@pytest.fixture
def account(smm):
    ct, ver = meta_token_vault.encrypt("EAAtoken")
    conn = MetaConnection.objects.create(token_ciphertext=ct, token_key_version=ver)
    return MetaAdAccount.objects.create(
        connection=conn, account_id="act_111", currency="USD", smm=smm, is_active=True
    )


# ---- parsing -----------------------------------------------------------------


def test_parse_insight_row_reads_actions_and_video():
    r = parse_insight_row(INSIGHT_ROW)
    assert r["date"] == TODAY
    assert r["spend"] == Decimal("12.34")
    assert r["impressions"] == 5000 and r["link_clicks"] == 120
    assert r["meta_leads"] == 7  # `lead`, без двойного счёта lead_grouped
    assert r["video_3s"] == 900 and r["thruplays"] == 180
    assert (r["video_p25"], r["video_p100"]) == (600, 100)
    assert r["video_avg_watch_sec"] == Decimal("6.4")


def test_parse_insight_row_falls_back_to_lead_grouped():
    row = {**INSIGHT_ROW, "actions": [{"action_type": "onsite_conversion.lead_grouped", "value": "3"}]}
    assert parse_insight_row(row)["meta_leads"] == 3


# ---- client ------------------------------------------------------------------


def test_client_follows_paging_and_sends_params():
    graph = FakeGraph()
    graph.insights_pages = [[INSIGHT_ROW], [{**INSIGHT_ROW, "date_start": "2026-10-31"}]]
    with _client(graph) as c:
        rows = list(c.insights("111", TODAY - dt.timedelta(days=1), TODAY))
    assert [r["date_start"] for r in rows] == ["2026-11-01", "2026-10-31"]
    first = graph.calls[0]
    assert first.url.path == "/v26.0/act_111/insights"
    q = parse_qs(urlparse(str(first.url)).query)
    assert q["level"] == ["ad"] and q["time_increment"] == ["1"]
    assert json.loads(q["time_range"][0]) == {"since": "2026-10-31", "until": "2026-11-01"}
    assert "video_thruplay_watched_actions" in q["fields"][0]
    assert q["access_token"] == ["EAAtoken"]


def test_client_retries_rate_limit_then_succeeds():
    graph = FakeGraph()
    graph.fail_once["/v26.0/me"] = (400, {"error": {"message": "User request limit reached", "code": 17}})
    with _client(graph) as c:
        assert c.me()["name"] == "Owner System User"
    assert len(graph.calls) == 2


def test_client_raises_auth_error_without_retry():
    graph = FakeGraph()
    graph.fail_once["/v26.0/me"] = (
        400, {"error": {"message": "Error validating access token", "code": 190}}
    )
    with _client(graph) as c, pytest.raises(MetaApiError) as exc:
        c.me()
    assert exc.value.is_auth_error and exc.value.code == 190
    assert len(graph.calls) == 1


# ---- sync --------------------------------------------------------------------


@pytest.mark.django_db
def test_account_sync_upserts_and_is_idempotent(account):
    graph = FakeGraph()
    fx_calls = []

    def fx(cur, day):
        fx_calls.append(day)
        return Decimal("12000")

    res = meta_account_sync(account, client=_client(graph), today=TODAY, fx_fetch=fx)
    assert res["since"] == (TODAY - dt.timedelta(days=89)).isoformat()  # первый раз — 90 дней
    assert MetaAdInsightDaily.objects.count() == 1
    ad = MetaAd.objects.get(ad_id="120249319606330361")
    assert ad.video_id == "v99" and ad.thumbnail_url.endswith("thumb.jpg")
    assert ad.preview_url.startswith("https://fb.me") and ad.campaign_name == "Noyabr"
    assert FxRate.objects.filter(currency="USD").count() == 90
    account.refresh_from_db()
    assert account.synced_since == TODAY - dt.timedelta(days=89)
    assert account.last_sync_error == ""

    # Повтор: та же строка обновляется, а не дублируется; окно — 7 дней.
    graph.insights_pages = [[{**INSIGHT_ROW, "spend": "15.00"}]]
    res = meta_account_sync(account, client=_client(graph), today=TODAY, fx_fetch=fx)
    assert res["since"] == (TODAY - dt.timedelta(days=6)).isoformat()
    row = MetaAdInsightDaily.objects.get()
    assert row.spend == Decimal("15.00") and row.currency == "USD"


@pytest.mark.django_db
def test_sync_drops_rows_meta_no_longer_returns_and_keeps_deleted_ads(account):
    graph = FakeGraph()
    meta_account_sync(account, client=_client(graph), today=TODAY, fx_fetch=lambda c, d: Decimal("1"))
    graph.insights_pages = [[{**INSIGHT_ROW, "ad_id": "999", "ad_name": "Archived ad"}]]
    graph.ads_rows = []  # удалённые объявления не приходят из /ads
    meta_account_sync(account, client=_client(graph), today=TODAY, fx_fetch=lambda c, d: Decimal("1"))
    assert list(MetaAdInsightDaily.objects.values_list("ad_id", flat=True)) == ["999"]
    assert MetaAd.objects.get(ad_id="999").name == "Archived ad"


@pytest.mark.django_db
def test_sync_error_is_saved_on_account(account):
    graph = FakeGraph()
    graph.fail_once["/v26.0/act_111/ads"] = (
        400, {"error": {"message": "Error validating access token", "code": 190}}
    )
    with pytest.raises(MetaApiError):
        meta_account_sync(account, client=_client(graph), today=TODAY)
    account.refresh_from_db()
    account.connection.refresh_from_db()
    assert "190" in account.last_sync_error
    assert "190" in account.connection.last_error


# ---- connection --------------------------------------------------------------


@pytest.mark.django_db
def test_connection_create_encrypts_token_and_lists_accounts(smm):
    graph = FakeGraph()
    conn = meta_connection_create(token="  EAAsecret  ", client=_client(graph, "EAAsecret"))
    assert conn.meta_user_name == "Owner System User"
    assert conn.token_expires_at is None  # expires_at=0 → бессрочный
    assert b"EAAsecret" not in bytes(conn.token_ciphertext)
    assert meta_token_vault.decrypt(bytes(conn.token_ciphertext), version=conn.token_key_version) == "EAAsecret"
    accounts = MetaAdAccount.objects.order_by("account_id")
    assert [a.account_id for a in accounts] == ["act_111", "act_222"]
    assert all(not a.is_active and a.smm_id is None for a in accounts)


@pytest.mark.django_db
def test_connection_create_rejects_bad_token():
    graph = FakeGraph()
    graph.fail_once["/v26.0/me"] = (400, {"error": {"message": "Invalid OAuth access token", "code": 190}})
    with pytest.raises(ValueError, match="Meta не приняла токен"):
        meta_connection_create(token="bad", client=_client(graph, "bad"))
    assert MetaConnection.objects.count() == 0


@pytest.mark.django_db
def test_connections_api_never_returns_token(db, monkeypatch):
    admin = User.objects.create_user(username="boss", password="x")
    Profile.objects.create(user=admin, role=Role.SUPERADMIN)
    graph = FakeGraph()
    monkeypatch.setattr(
        "apps.marketing.meta_services.MetaClient",
        lambda token: _client(graph, token),
    )
    api = APIClient()
    api.force_authenticate(admin)
    r = api.post("/api/marketing/meta/connections/", {"token": "EAAsecret"}, format="json")
    assert r.status_code == 201, r.data
    assert len(r.data["accounts"]) == 2
    listing = api.get("/api/marketing/meta/connections/")
    assert "EAAsecret" not in json.dumps(listing.data)
    assert "token" not in listing.data[0]

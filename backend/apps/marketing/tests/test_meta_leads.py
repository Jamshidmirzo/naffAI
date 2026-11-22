"""
Лид-формы Meta → лиды CRM: токен страницы, формы, фильтр по времени, разбор
field_data, атрибуция SMM и объявления, дедуп, ошибки, API настроек.
"""

from __future__ import annotations

import datetime as dt
import json
from urllib.parse import parse_qs, urlparse

import httpx
import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from apps.common.crypto import meta_token_vault
from apps.leads.models import InboundLeadEvent, Lead, SheetSourceKind
from apps.marketing.integrations.meta.client import MetaApiError, MetaClient
from apps.marketing.integrations.meta.leads import meta_page_leads_sync, parse_meta_time
from apps.marketing.meta_services import meta_page_update, meta_pages_refresh
from apps.marketing.models import MetaConnection, MetaLeadForm, MetaPage
from apps.marketing.smm_selectors import smm_dashboard
from apps.operators.models import Operator
from apps.users.models import Profile, Role

User = get_user_model()


def _lead(lid: str, phone: str, created: str, ad_id: str = "120001") -> dict:
    return {
        "id": lid,
        "created_time": created,
        "ad_id": ad_id,
        "ad_name": "Video 1",
        "adset_id": "s1",
        "adset_name": "Toshkent 18-35",
        "campaign_id": "c1",
        "campaign_name": "Noyabr",
        "form_id": "F1",
        "is_organic": False,
        "platform": "ig",
        "field_data": [
            {"name": "full_name", "values": ["Ali Valiyev"]},
            {"name": "phone_number", "values": [phone]},
            {"name": "qaysi_telefon_kerak?", "values": ["iPhone 16"]},
        ],
    }


class FakeGraph:
    def __init__(self):
        self.calls: list[httpx.Request] = []
        self.leads = [_lead("L1", "+998901112233", "2026-11-02T09:00:00+0000")]
        self.fail: dict[str, tuple[int, dict]] = {}

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.calls.append(request)
        path = request.url.path
        if path in self.fail:
            code, body = self.fail[path]
            return httpx.Response(code, json=body)
        if path.endswith("/me/accounts"):
            return httpx.Response(200, json={"data": [
                {"id": "P1", "name": "NAFF Store", "tasks": ["ADVERTISE", "MANAGE"], "access_token": "PAGE-TOKEN"},
            ]})
        if path.endswith("/P1/leadgen_forms"):
            assert request.headers["Authorization"] == "Bearer PAGE-TOKEN"
            return httpx.Response(200, json={"data": [
                {"id": "F1", "name": "Rassrochka forma", "status": "ACTIVE"},
                {"id": "F0", "name": "Old", "status": "ARCHIVED"},
            ]})
        if path.endswith("/F1/leads"):
            assert request.headers["Authorization"] == "Bearer PAGE-TOKEN"
            return httpx.Response(200, json={"data": self.leads})
        if path.endswith("/F0/leads"):
            raise AssertionError("archived form must not be polled")
        return httpx.Response(404, json={"error": {"message": f"unknown {path}", "code": 100}})


def _client(graph: FakeGraph) -> MetaClient:
    return MetaClient("SYS-TOKEN", transport=httpx.MockTransport(graph), sleep=lambda s: None)


@pytest.fixture
def smm(db):
    u = User.objects.create_user(username="sarvar", password="x", first_name="Sarvar")
    Profile.objects.create(user=u, role=Role.SMM)
    return u


@pytest.fixture
def op(db):
    return Operator.objects.create(full_name="Op", phone="+998900000001", status="active")


@pytest.fixture
def page(smm):
    ct, ver = meta_token_vault.encrypt("SYS-TOKEN")
    conn = MetaConnection.objects.create(token_ciphertext=ct, token_key_version=ver)
    graph = FakeGraph()
    meta_pages_refresh(conn, _client(graph))
    p = MetaPage.objects.get(page_id="P1")
    since = timezone.make_aware(dt.datetime(2026, 11, 2, 8, 0), dt.UTC)
    meta_page_update(p, smm_id=smm.id, leads_enabled=True)
    MetaPage.objects.filter(pk=p.pk).update(leads_since=since)
    p.refresh_from_db()
    return p


@pytest.mark.django_db
def test_token_never_in_url(page, op):
    graph = FakeGraph()
    meta_page_leads_sync(page, client=_client(graph))
    assert graph.calls
    for c in graph.calls:
        assert "access_token=" not in str(c.url) and "TOKEN" not in str(c.url)


def test_parse_meta_time():
    assert parse_meta_time("2026-11-02T09:00:00+0000") == dt.datetime(2026, 11, 2, 9, 0, tzinfo=dt.UTC)
    assert parse_meta_time("") is None


@pytest.mark.django_db
def test_pages_refresh_and_enable_creates_hot_source_for_smm(page, smm):
    assert page.name == "NAFF Store" and page.tasks == ["ADVERTISE", "MANAGE"]
    src = page.source
    assert src.kind == SheetSourceKind.WEBHOOK and src.webhook_token is None and src.webhook_api_key == ""
    assert src.smm_id == smm.id and src.is_hot and src.active
    assert src.name == "Meta · NAFF Store"


@pytest.mark.django_db
def test_sync_imports_lead_with_ad_and_form_attribution(page, smm, op):
    graph = FakeGraph()
    res = meta_page_leads_sync(page, client=_client(graph))
    assert res["created"] == 1 and res["forms"] == 1
    lead = Lead.objects.get()
    assert lead.full_name == "Ali Valiyev" and lead.phone.endswith("901112233")
    assert lead.sheet_source_id == page.source_id
    ad = lead.metadata["ad"]
    assert ad["meta_lead_id"] == "L1" and ad["ad_id"] == "120001"
    assert ad["campaign_name"] == "Noyabr" and ad["form_name"] == "Rassrochka forma"
    assert "iPhone 16" in lead.product_hint
    form = MetaLeadForm.objects.get(form_id="F1")
    assert form.leads_imported == 1 and form.last_lead_at == parse_meta_time("2026-11-02T09:00:00+0000")
    # time filter sent to Meta (since = leads_since on the first poll)
    leads_call = next(c for c in graph.calls if c.url.path.endswith("/F1/leads"))
    flt = json.loads(parse_qs(urlparse(str(leads_call.url)).query)["filtering"][0])
    assert flt[0]["field"] == "time_created" and flt[0]["value"] == int(page.leads_since.timestamp())
    # the lead counts for the SMM
    d = smm_dashboard(smm_id=smm.id, date_from=dt.date(2026, 1, 1), date_to=timezone.localdate())
    assert d["totals"]["crm_leads"] == 1 and d["ads"][0]["ad_id"] == "120001"


@pytest.mark.django_db
def test_second_poll_dedupes_and_uses_overlap(page, op):
    graph = FakeGraph()
    meta_page_leads_sync(page, client=_client(graph))
    graph.leads = [
        _lead("L1", "+998901112233", "2026-11-02T09:00:00+0000"),
        _lead("L2", "+998904445566", "2026-11-02T09:05:00+0000"),
    ]
    graph.calls.clear()
    res = meta_page_leads_sync(page, client=_client(graph))
    assert res["created"] == 1 and res["duplicate"] == 1
    assert Lead.objects.count() == 2
    assert InboundLeadEvent.objects.filter(source=page.source).count() == 3
    leads_call = next(c for c in graph.calls if c.url.path.endswith("/F1/leads"))
    flt = json.loads(parse_qs(urlparse(str(leads_call.url)).query)["filtering"][0])
    expected = parse_meta_time("2026-11-02T09:00:00+0000") - dt.timedelta(minutes=10)
    assert flt[0]["value"] == int(expected.timestamp())


@pytest.mark.django_db
def test_leads_older_than_enable_moment_are_skipped(page, op):
    graph = FakeGraph()
    graph.leads = [_lead("OLD", "+998907778899", "2026-11-02T07:59:59+0000")]
    res = meta_page_leads_sync(page, client=_client(graph))
    assert res["created"] == 0 and not Lead.objects.exists()


@pytest.mark.django_db
def test_disabled_page_or_inactive_source_is_skipped(page):
    graph = FakeGraph()
    page.source.active = False
    page.source.save()
    assert meta_page_leads_sync(page, client=_client(graph))["skipped"] == "source inactive"
    meta_page_update(page, leads_enabled=False)
    assert meta_page_leads_sync(page, client=_client(graph))["skipped"] == "disabled"
    assert not graph.calls


@pytest.mark.django_db
def test_permission_error_is_saved_on_page(page):
    graph = FakeGraph()
    graph.fail["/v26.0/P1/leadgen_forms"] = (
        403, {"error": {"message": "(#200) Requires leads_retrieval permission", "code": 200}}
    )
    with pytest.raises(MetaApiError):
        meta_page_leads_sync(page, client=_client(graph))
    page.refresh_from_db()
    assert "leads_retrieval" in page.last_poll_error


@pytest.mark.django_db
def test_reassigning_page_moves_source_to_new_smm(page):
    other = User.objects.create_user(username="bekzod", password="x")
    Profile.objects.create(user=other, role=Role.SMM)
    meta_page_update(page, smm_id=other.id)
    page.source.refresh_from_db()
    assert page.source.smm_id == other.id


@pytest.mark.django_db
def test_pages_api_enable_with_backfill_and_smm_blocked(page, smm, monkeypatch):
    admin = User.objects.create_user(username="boss", password="x")
    Profile.objects.create(user=admin, role=Role.SUPERADMIN)
    meta_page_update(page, leads_enabled=False)
    api = APIClient()
    api.force_authenticate(admin)
    rows = api.get("/api/marketing/meta/pages/").json()
    assert rows[0]["name"] == "NAFF Store" and rows[0]["smm_name"] == "Sarvar"
    before = timezone.now()
    r = api.patch(f"/api/marketing/meta/pages/{page.id}/", {"leads_enabled": True, "backfill_hours": 24}, format="json")
    assert r.status_code == 200 and r.json()["leads_enabled"] is True
    page.refresh_from_db()
    assert before - dt.timedelta(hours=24, seconds=5) <= page.leads_since <= timezone.now() - dt.timedelta(hours=23)
    monkeypatch.setattr("apps.marketing.smm_apis.meta_page_sync_now", lambda p: {"created": 0})
    assert api.post(f"/api/marketing/meta/pages/{page.id}/sync/").status_code == 200
    assert api.get("/api/marketing/meta/connections/").json()[0]["pages"][0]["page_id"] == "P1"

    api.force_authenticate(smm)
    assert api.get("/api/marketing/meta/pages/").status_code == 403
    assert api.patch(f"/api/marketing/meta/pages/{page.id}/", {"leads_enabled": False}, format="json").status_code == 403

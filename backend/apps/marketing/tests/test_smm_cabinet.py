"""
Кабинет SMM-специалиста: привязка источников, цифры, права, лиды, бот.
"""

from __future__ import annotations

import datetime as dt
from decimal import Decimal
from itertools import count

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from apps.catalog.models import Channel
from apps.leads.integrations.webhook.parse import ad_from_sheet_row
from apps.leads.models import Lead, LeadSource, LeadStatus, SheetSource, SheetSourceKind
from apps.marketing.models import FxRate, MetaAd, MetaAdAccount, MetaAdInsightDaily, MetaConnection
from apps.marketing.smm_selectors import NO_AD, smm_dashboard
from apps.operators.models import Operator
from apps.sales.models import Sale
from apps.users.models import Profile, Role

User = get_user_model()
_rows = count(1)


def _user(username: str, role: str, **extra) -> User:
    u = User.objects.create_user(username=username, password="x", **extra)
    Profile.objects.create(user=u, role=role)
    return u


@pytest.fixture
def api():
    return APIClient()


@pytest.fixture
def manager(db):
    return _user("mgr", Role.MANAGER)


@pytest.fixture
def smm_a(db):
    return _user("smm_a", Role.SMM, first_name="Sarvar")


@pytest.fixture
def smm_b(db):
    return _user("smm_b", Role.SMM, first_name="Bekzod")


@pytest.fixture
def op(db):
    return Operator.objects.create(full_name="Op One", phone="+998900000001", status="active")


@pytest.fixture
def channel(db):
    return Channel.objects.create(name="Cash", is_active=True)


@pytest.fixture
def sheet_a(smm_a):
    return SheetSource.objects.create(name="Target A", spreadsheet_id="ssA", gid=1, smm=smm_a)


@pytest.fixture
def hook_b(smm_b):
    return SheetSource.objects.create(
        name="LeadPixel B", kind=SheetSourceKind.WEBHOOK, webhook_token="tokB", smm=smm_b
    )


@pytest.fixture
def account_a(smm_a):
    conn = MetaConnection.objects.create(name="owner", token_ciphertext=b"x")
    return MetaAdAccount.objects.create(
        connection=conn, account_id="act_111", name="Sarvar Ads", currency="USD",
        smm=smm_a, is_active=True,
    )


TODAY = dt.date(2026, 11, 1)


def _at(day: dt.date, hour: int = 12) -> dt.datetime:
    return timezone.make_aware(dt.datetime.combine(day, dt.time(hour)))


def _lead(source, *, day=TODAY, ad_id="", status=LeadStatus.NEW, phone=None, **ad) -> Lead:
    n = next(_rows)
    meta = {"ad": {"ad_id": ad_id, **ad}} if ad_id or ad else {}
    lead = Lead.objects.create(
        full_name=f"Client {n}",
        phone=phone or f"+99890{n:07d}",
        status=status,
        source=LeadSource.SHEET,
        sheet_source=source,
        sheet_row_index=n,
        metadata=meta,
    )
    Lead.objects.filter(pk=lead.pk).update(created_at=_at(day))
    lead.refresh_from_db()
    return lead


def _sale(lead, op, channel, amount="10000000", discount="0", day=TODAY) -> Sale:
    return Sale.objects.create(
        imei=f"35{next(_rows):013d}",
        phone_model="iPhone 15",
        operator=op,
        channel=channel,
        amount=Decimal(amount),
        discount=Decimal(discount),
        sold_at=_at(day, 15),
        lead=lead,
        sheet_source=lead.sheet_source if lead else None,
        status="confirmed",
    )


def _insight(account, ad_id, *, day=TODAY, spend="20.00", impressions=1000, meta_leads=4, **kw):
    return MetaAdInsightDaily.objects.create(
        ad_account=account, ad_id=ad_id, date=day, spend=Decimal(spend), currency="USD",
        impressions=impressions, meta_leads=meta_leads,
        ad_name=kw.pop("ad_name", f"Ad {ad_id}"), campaign_id=kw.pop("campaign_id", "c1"),
        campaign_name=kw.pop("campaign_name", "Noyabr"), **kw,
    )


# ---- attribution & math ----------------------------------------------------


@pytest.mark.django_db
def test_dashboard_counts_only_own_sources_and_computes_cpl_romi(
    smm_a, smm_b, sheet_a, hook_b, account_a, op, channel
):
    FxRate.objects.create(date=TODAY, currency="USD", rate=Decimal("12000"))
    _insight(account_a, "ad1", spend="20.00", impressions=1000, meta_leads=4, video_3s=300, thruplays=60)
    MetaAd.objects.create(ad_account=account_a, ad_id="ad1", name="Video 1", thumbnail_url="https://x/t.jpg")

    won = _lead(sheet_a, ad_id="ad1", status=LeadStatus.WON)
    _lead(sheet_a, ad_id="ad1")
    _lead(sheet_a)  # из таблицы без колонки ad_id
    _sale(won, op, channel, amount="2000000", discount="200000")
    _lead(hook_b, ad_id="adB")  # чужой SMM

    d = smm_dashboard(smm_id=smm_a.id, date_from=TODAY, date_to=TODAY)
    t = d["totals"]
    assert t["crm_leads"] == 3
    assert t["meta_leads"] == 4
    assert t["spend"] == "20.00"
    assert t["spend_uzs"] == "240000"
    assert t["cpl"] == "6.67"  # 20$ / 3 лида CRM
    assert t["sales"] == 1 and t["converted"] == 1
    assert t["revenue"] == "1800000"  # нетто: amount − discount
    assert t["romi_pct"] == 650.0  # (1 800 000 − 240 000) / 240 000
    assert d["currency"] == "USD"

    ad = next(a for a in d["ads"] if a["ad_id"] == "ad1")
    assert ad["name"] == "Video 1"
    assert ad["crm_leads"] == 2 and ad["sales"] == 1
    assert ad["cpl"] == "10.00"
    assert ad["hook_rate"] == 30.0 and ad["hold_rate"] == 20.0
    assert d["no_ad"]["crm_leads"] == 1
    assert [c["name"] for c in d["campaigns"]] == ["Noyabr"]
    assert {s["id"] for s in d["sources"]} == {sheet_a.id}
    assert len(d["daily"]) == 1 and d["daily"][0]["crm_leads"] == 3

    other = smm_dashboard(smm_id=smm_b.id, date_from=TODAY, date_to=TODAY)
    assert other["totals"]["crm_leads"] == 1
    assert other["totals"]["spend"] == "0.00"
    assert other["meta_connected"] is False


@pytest.mark.django_db
def test_dashboard_fx_falls_back_to_earlier_rate(smm_a, sheet_a, account_a):
    FxRate.objects.create(date=TODAY - dt.timedelta(days=3), currency="USD", rate=Decimal("11000"))
    _insight(account_a, "ad1", spend="10.00")
    d = smm_dashboard(smm_id=smm_a.id, date_from=TODAY, date_to=TODAY)
    assert d["totals"]["spend_uzs"] == "110000"


@pytest.mark.django_db
def test_crm_only_ad_from_lead_metadata_appears_in_table(smm_a, sheet_a):
    _lead(sheet_a, ad_id="adX", ad_name="Banner X", campaign_name="Dekabr")
    d = smm_dashboard(smm_id=smm_a.id, date_from=TODAY, date_to=TODAY)
    ad = d["ads"][0]
    assert ad["ad_id"] == "adX" and ad["name"] == "Banner X"
    assert ad["campaign_name"] == "Dekabr"
    assert ad["in_meta"] is False and ad["spend"] == "0.00" and ad["cpl"] is None


# ---- sheet attribution columns ---------------------------------------------


def test_ad_from_sheet_row_reads_meta_export_columns():
    row = {
        "full_name": "Ali",
        "phone_number": "+998901234567",
        "Ad ID": "ag:120249319606330361",
        "ad_name": "Video 1",
        "adset_name": "Toshkent 18-35",
        "Campaign Name": "Sentyabr",
        "form_id": "f:900112233",
        "platform": "ig",
        "id": "l:555",  # общий id не берём
        "__cells__": ["x"],
    }
    ad = ad_from_sheet_row(row)
    assert ad == {
        "form_id": "900112233",
        "campaign_name": "Sentyabr",
        "adset_name": "Toshkent 18-35",
        "ad_id": "120249319606330361",
        "ad_name": "Video 1",
        "platform": "ig",
    }
    assert ad_from_sheet_row({"full_name": "Ali", "phone": "+998901234567"}) == {}


@pytest.mark.django_db
def test_sheet_import_stores_ad_metadata(sheet_a):
    from apps.leads.services import lead_create_from_sheet_row

    sheet_a.column_map = {"full_name": "full_name", "phone": "phone_number"}
    sheet_a.save()
    lead, outcome = lead_create_from_sheet_row(
        sheet_source=sheet_a,
        row_index=5,
        raw_row={"full_name": "Ali", "phone_number": "+998901234567", "ad_id": "ag:777"},
    )
    assert outcome == "created"
    assert lead.metadata["ad"] == {"ad_id": "777"}


# ---- API & permissions -----------------------------------------------------


@pytest.mark.django_db
def test_smm_sees_only_self_even_with_param(api, smm_a, smm_b, sheet_a, hook_b):
    _lead(sheet_a, day=timezone.localdate())
    _lead(hook_b, day=timezone.localdate())
    api.force_authenticate(smm_a)
    r = api.get(f"/api/marketing/smm/dashboard/?smm={smm_b.id}")
    assert r.status_code == 200
    assert r.data["smm"]["id"] == smm_a.id
    assert r.data["totals"]["crm_leads"] == 1

    r = api.get(f"/api/marketing/smm/leads/?smm={smm_b.id}")
    assert r.status_code == 200
    assert r.data["count"] == 1
    row = r.data["results"][0]
    assert row["source_id"] == sheet_a.id
    assert row["phone"].startswith("+99890")  # телефоны SMM видит

    r = api.get("/api/marketing/smm/")
    assert [x["id"] for x in r.data] == [smm_a.id]


@pytest.mark.django_db
def test_smm_blocked_from_manager_and_crm_endpoints(api, smm_a, account_a):
    api.force_authenticate(smm_a)
    for url in (
        "/api/marketing/smm/overview/",
        "/api/marketing/meta/connections/",
        "/api/marketing/meta/ad-accounts/",
        "/api/marketing/dashboard/",
        "/api/leads/",
        "/api/sales/",
        "/api/sheet-sources/",
    ):
        assert api.get(url).status_code == 403, url
    r = api.patch(f"/api/marketing/meta/ad-accounts/{account_a.id}/", {"smm_id": None}, format="json")
    assert r.status_code == 403


@pytest.mark.django_db
def test_smm_can_sync_only_own_ad_account(api, smm_a, smm_b, account_a, monkeypatch):
    calls = []
    monkeypatch.setattr(
        "apps.marketing.smm_apis.meta_ad_account_sync_now",
        lambda account, days=None: calls.append(account.id) or {"ads": 0},
    )
    api.force_authenticate(smm_b)
    assert api.post(f"/api/marketing/meta/ad-accounts/{account_a.id}/sync/").status_code == 404
    api.force_authenticate(smm_a)
    assert api.post(f"/api/marketing/meta/ad-accounts/{account_a.id}/sync/").status_code == 200
    assert calls == [account_a.id]


@pytest.mark.django_db
def test_manager_dashboard_requires_smm_and_sees_overview(api, manager, smm_a, smm_b, sheet_a):
    api.force_authenticate(manager)
    assert api.get("/api/marketing/smm/dashboard/").status_code == 400
    r = api.get(f"/api/marketing/smm/dashboard/?smm={smm_a.id}")
    assert r.status_code == 200 and r.data["smm"]["name"] == "Sarvar"
    r = api.get("/api/marketing/smm/overview/")
    assert r.status_code == 200
    assert {row["id"] for row in r.data["rows"]} == {smm_a.id, smm_b.id}
    # Не-SMM в качестве ?smm= не принимаем.
    assert api.get(f"/api/marketing/smm/dashboard/?smm={manager.id}").status_code == 400


@pytest.mark.django_db
def test_manager_binds_sources_to_smm(api, manager, smm_a, smm_b, sheet_a, hook_b):
    api.force_authenticate(manager)
    r = api.put(
        f"/api/marketing/smm/{smm_a.id}/sources/", {"source_ids": [hook_b.id]}, format="json"
    )
    assert r.status_code == 200
    sheet_a.refresh_from_db()
    hook_b.refresh_from_db()
    assert sheet_a.smm_id is None and hook_b.smm_id == smm_a.id

    r = api.patch(f"/api/sheet-sources/{sheet_a.id}/", {"smm_id": smm_b.id}, format="json")
    assert r.status_code == 200, r.data
    assert r.data["smm_id"] == smm_b.id and r.data["smm_name"] == "Bekzod"
    r = api.patch(f"/api/sheet-sources/{sheet_a.id}/", {"smm_id": manager.id}, format="json")
    assert r.status_code == 400
    r = api.patch(f"/api/sheet-sources/{sheet_a.id}/", {"smm_id": None}, format="json")
    assert r.status_code == 200 and r.data["smm_id"] is None


@pytest.mark.django_db
def test_manager_assigns_ad_account_only_to_smm(api, manager, smm_a, account_a):
    api.force_authenticate(manager)
    url = f"/api/marketing/meta/ad-accounts/{account_a.id}/"
    assert api.patch(url, {"smm_id": manager.id}, format="json").status_code == 400
    r = api.patch(url, {"smm_id": None, "is_active": False}, format="json")
    assert r.status_code == 200 and r.data["smm_id"] is None and r.data["is_active"] is False


@pytest.mark.django_db
def test_create_smm_user_via_users_api(api, db):
    admin = _user("boss", Role.SUPERADMIN)
    api.force_authenticate(admin)
    r = api.post("/api/users/", {"username": "target1", "role": "smm", "full_name": "Ali Target"}, format="json")
    assert r.status_code == 201, r.data
    assert r.data["role"] == "smm" and r.data["password"]
    r = api.post("/api/auth/login/", {"username": "target1", "password": r.data["password"]}, format="json")
    assert r.status_code == 200 and r.data["role"] == "smm"


# ---- bot ---------------------------------------------------------------------


@pytest.mark.django_db
def test_bot_report_scoped_to_smm(smm_a, sheet_a, hook_b, op, channel):
    from apps.tg_bot.report_blocks import render_sales_by_sheet_source

    _sale(_lead(sheet_a, status=LeadStatus.WON), op, channel, amount="3000000")
    _sale(_lead(hook_b, status=LeadStatus.WON), op, channel, amount="5000000")
    start, end = _at(TODAY, 0), _at(TODAY + dt.timedelta(days=1), 0)

    everyone = render_sales_by_sheet_source(start, end, "ru")
    assert "Target A" in everyone and "LeadPixel B" in everyone

    mine = render_sales_by_sheet_source(start, end, "ru", smm_id=smm_a.id)
    assert "Target A" in mine and "LeadPixel B" not in mine
    assert "Лиды в CRM" in mine


def test_no_ad_sentinel_is_not_a_real_ad_id():
    assert NO_AD.startswith("__")

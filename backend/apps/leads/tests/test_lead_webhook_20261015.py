"""
Webhook lead intake (generic JSON / Meta lead object / the former LeadPixel
format, 2026-10-15). «Статусы обратно» в LeadPixel удалены 2026-11-02.

Pins:
  * POST /api/integrations/leads/<token>/ — 404 for a wrong token; 401
    {"error": "invalid key"} for a missing / wrong X-API-Key BEFORE the body
    is looked at; GET ping without a key; `{}` → 400; 201 created / 200
    merged & duplicate, always with "id": "<lead id>" (string);
  * meta_lead_id / Idempotency-Key dedupe returns the same id;
  * the LeadPixel body (fields: [{name, value}]) → name / phone / product /
    metadata ad / answers / comment;
  * routing like a sheet row (pool, availability, hot SLA, merge, review);
  * Google sync paths and health endpoints don't touch Google for webhook
    sources;
  * `create_webhook_source` key flow.
"""

from __future__ import annotations

import io
import json
from datetime import timedelta
from decimal import Decimal
from unittest.mock import MagicMock, patch

import pytest
from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.core.management import CommandError, call_command
from django.test import override_settings
from django.utils import timezone
from rest_framework.test import APIClient

from apps.attendance.models import AttendanceLog
from apps.attendance.selectors import attendance_settings_get
from apps.catalog.models import Channel
from apps.leads.integrations.webhook.services import webhook_source_create
from apps.leads.models import (
    DistributionMode,
    InboundLeadEvent,
    Lead,
    LeadSource,
    LeadStatus,
    LeadStatusLabel,
    SheetSource,
    SheetSourceKind,
    SheetWritebackJob,
)
from apps.leads.services import (
    lead_convert_to_sale,
    lead_create_from_sheet_row,
    lead_mark_system_lost,
    lead_update_status,
)
from apps.operators.models import Operator, OperatorStatus
from apps.users.models import Profile, Role

pytestmark = pytest.mark.django_db

User = get_user_model()

LEADPIXEL_BODY = {
    "name": "Ali Valiyev",
    "phone": "+998901234567",
    "email": None,
    "source": "Meta Ads",
    "meta_lead_id": "1023323200742493",
    "ad_id": "120249319606330361",
    "ad_name": "Video 1",
    "adset_name": "Toshkent 18-35",
    "campaign_name": "Sentyabr",
    "form_id": "900112233",
    "created_at": "2026-09-07T07:12:31.000Z",
    "utm_source": "facebook",
    "utm_medium": "cpc",
    "utm_campaign": "Sentyabr",
    "utm_content": "120249319606330361",
    "comment": "Заявка из формы Meta · кампания «Сентябрь»",
    "fields": [
        {"name": "full_name", "value": "Ali Valiyev"},
        {"name": "phone_number", "value": "+998901234567"},
        {"name": "qaysi_kurs", "value": "Frontend"},
    ],
}


@pytest.fixture(autouse=True)
def _clear_throttle_cache():
    cache.clear()
    yield
    cache.clear()


@pytest.fixture
def ops() -> tuple[Operator, Operator]:
    return (
        Operator.objects.create(full_name="Alice", status=OperatorStatus.ACTIVE),
        Operator.objects.create(full_name="Bob", status=OperatorStatus.ACTIVE),
    )


@pytest.fixture
def src(ops) -> SheetSource:
    return webhook_source_create(name="LeadPixel (Meta)")


@pytest.fixture
def sheet() -> SheetSource:
    return SheetSource.objects.create(
        name="Google sheet",
        spreadsheet_id="SS1",
        gid=1,
        column_map={"phone": "phone", "full_name": "name"},
        distribution_mode=DistributionMode.ALIAS_OR_ROUND_ROBIN,
    )


def _url(source: SheetSource) -> str:
    return f"/api/integrations/leads/{source.webhook_token}/"


def _post(source, body, *, key: str | None = "__source__", **extra):
    headers = {}
    if key == "__source__":
        key = source.webhook_api_key
    if key is not None:
        headers["HTTP_X_API_KEY"] = key
    headers.update(extra)
    return APIClient().post(
        _url(source), data=json.dumps(body), content_type="application/json", **headers
    )


def _mgr_client() -> APIClient:
    user = User.objects.create_user(username="mgr", password="mgrpass1")
    Profile.objects.create(user=user, role=Role.MANAGER)
    c = APIClient()
    c.force_authenticate(user=user)
    return c


# ---- inbound: routing / auth -------------------------------------------


def test_wrong_token_404_even_with_key(src):
    r = APIClient().post(
        "/api/integrations/leads/nope/", {"phone": "901234567"}, format="json",
        HTTP_X_API_KEY=src.webhook_api_key,
    )
    assert r.status_code == 404
    src.active = False
    src.save(update_fields=["active"])
    assert _post(src, {"phone": "901234567"}).status_code == 404
    assert not Lead.objects.exists()


def test_missing_or_wrong_key_401_before_body(src):
    for key in (None, "", "wrong", src.webhook_api_key[:-1]):
        r = _post(src, LEADPIXEL_BODY, key=key)
        assert r.status_code == 401, key
        assert r.json()["error"] == "invalid key"
    # Битое тело с плохим ключом — всё равно 401, тело не смотрим.
    r = APIClient().post(_url(src), data="{garbage", content_type="application/json", HTTP_X_API_KEY="bad")
    assert r.status_code == 401
    # …и гигантское тело тоже.
    r = _post(src, {"junk": "x" * (300 * 1024)}, key="bad")
    assert r.status_code == 401
    assert not Lead.objects.exists()
    assert not InboundLeadEvent.objects.exists()


def test_source_without_key_is_closed(src):
    src.webhook_api_key = ""
    src.save(update_fields=["webhook_api_key"])
    assert _post(src, LEADPIXEL_BODY, key="").status_code == 401


def test_sheet_source_has_no_webhook(sheet):
    sheet.webhook_token = "sheet-token"
    sheet.save(update_fields=["webhook_token"])
    r = APIClient().post("/api/integrations/leads/sheet-token/", {"phone": "901234567"}, format="json")
    assert r.status_code == 404


def test_get_and_head_ping_without_key(src):
    r = APIClient().get(_url(src))
    assert r.status_code == 200
    assert r.json() == {"ok": True, "source": "LeadPixel (Meta)"}
    assert APIClient().head(_url(src)).status_code == 200


def test_empty_object_connect_check_is_400(src):
    r = _post(src, {})
    assert r.status_code == 400
    assert r.json()["error"] == "phone and meta_lead_id required"
    r = _post(src, {"name": "Only name", "meta_lead_id": "1"})
    assert r.status_code == 400
    assert not Lead.objects.exists()


def test_payload_too_large(src):
    r = _post(src, {"name": "A", "phone": "901234567", "junk": "x" * (300 * 1024)})
    assert r.status_code == 413
    assert not Lead.objects.exists()


# ---- inbound: LeadPixel body --------------------------------------------


def test_leadpixel_body_creates_lead_201_with_string_id(src, ops):
    r = _post(src, LEADPIXEL_BODY, HTTP_IDEMPOTENCY_KEY="1023323200742493")
    assert r.status_code == 201, r.content
    body = r.json()
    lead = Lead.objects.get()
    assert body["id"] == str(lead.id) and isinstance(body["id"], str)
    assert body["lead_id"] == lead.id and body["result"] == "created"

    assert lead.source == LeadSource.WEBHOOK and lead.sheet_source_id == src.id
    assert (lead.full_name, lead.phone) == ("Ali Valiyev", "+998901234567")
    assert lead.product_hint == "qaysi_kurs: Frontend"
    ad = lead.metadata["ad"]
    assert ad["meta_lead_id"] == "1023323200742493"
    assert ad["ad_id"] == "120249319606330361"  # 18 цифр — строкой
    assert ad["source"] == "Meta Ads" and ad["created_at"] == "2026-09-07T07:12:31.000Z"
    assert ad["utm_content"] == "120249319606330361"
    assert lead.metadata["answers"] == LEADPIXEL_BODY["fields"]
    assert lead.metadata["comment"].startswith("Заявка из формы Meta")
    assert "email" not in lead.metadata
    assert lead.operator_id in {ops[0].id, ops[1].id}

    ev = InboundLeadEvent.objects.get()
    assert (ev.outcome, ev.external_id, ev.lead_id) == ("created", "1023323200742493", lead.id)
    src.refresh_from_db()
    assert src.last_synced_at is not None


def test_meta_lead_id_duplicate_returns_same_id(src):
    r1 = _post(src, LEADPIXEL_BODY)
    r2 = _post(src, {**LEADPIXEL_BODY, "phone": "+998909999999"})
    assert r1.status_code == 201 and r2.status_code == 200
    assert r2.json()["id"] == r1.json()["id"]
    assert r2.json()["result"] == "duplicate"
    assert Lead.objects.count() == 1


def test_idempotency_key_header_dedupes_generic_sender(src):
    body = {"name": "A", "phone": "901000001"}
    r1 = _post(src, body, HTTP_IDEMPOTENCY_KEY="IDEM-1")
    r2 = _post(src, {"name": "A", "phone": "901000777"}, HTTP_IDEMPOTENCY_KEY="IDEM-1")
    assert r2.status_code == 200
    assert r2.json() == {"ok": True, "lead_id": r1.json()["lead_id"], "id": r1.json()["id"], "result": "duplicate"}
    lead = Lead.objects.get()
    # Пришёл только заголовком — сохранён как meta_lead_id (для статусов).
    assert lead.metadata["ad"]["meta_lead_id"] == "IDEM-1"


def test_merge_returns_existing_lead_id(src, sheet, ops):
    existing, _ = lead_create_from_sheet_row(
        sheet_source=sheet, row_index=2, raw_row={"name": "Old", "phone": "901234567"}
    )
    op_before = existing.operator_id
    r = _post(src, LEADPIXEL_BODY)
    assert r.status_code == 200
    assert r.json()["result"] == "merged" and r.json()["id"] == str(existing.id)
    existing.refresh_from_db()
    assert Lead.objects.count() == 1
    assert existing.sheet_source_id == sheet.id and existing.operator_id == op_before
    trail = existing.metadata["duplicate_webhook_events"][0]
    assert trail["source_id"] == src.id and trail["external_id"] == "1023323200742493"
    assert trail["ad"]["ad_id"] == "120249319606330361"


def test_flat_and_meta_and_form_formats_still_work(src):
    assert _post(src, {"Name": "A", "Phone": "+998 90 100 00 01"}).status_code == 201
    r = _post(src, {"id": "15", "field_data": [{"name": "full_name", "values": ["B"]},
                                               {"name": "phone_number", "values": ["901000002"]}]})
    assert r.status_code == 201
    r = APIClient().post(_url(src), data="Name=C&Phone=%2B998901000003",
                         content_type="application/x-www-form-urlencoded",
                         HTTP_X_API_KEY=src.webhook_api_key)
    assert r.status_code == 201
    r = APIClient().post(_url(src), {"name": "D", "phone": "901000004"}, format="multipart",
                         HTTP_X_API_KEY=src.webhook_api_key)
    assert r.status_code == 201
    assert Lead.objects.count() == 4


def test_meta_envelope_and_array_are_batches(src):
    body = {"object": "page", "entry": [
        {"changes": [{"value": {"leadgen_id": "a1", "full_name": "A", "phone": "901000001"}}]},
        {"changes": [{"value": {"leadgen_id": "a2", "full_name": "B", "phone": "901000002"}}]},
    ]}
    r = _post(src, body)
    assert r.status_code == 200
    assert [x["result"] for x in r.json()["results"]] == ["created", "created"]
    assert all(isinstance(x["id"], str) for x in r.json()["results"])
    r = _post(src, [{"name": "C", "phone": "901000003"}, {"foo": "bar"}])
    res = r.json()["results"]
    assert res[0]["result"] == "created" and res[1]["result"] == "invalid"


def test_unparsable_json_is_400(src):
    r = APIClient().post(_url(src), data="{not json", content_type="application/json",
                         HTTP_X_API_KEY=src.webhook_api_key)
    assert r.status_code == 400
    assert InboundLeadEvent.objects.filter(outcome="invalid").count() == 1


# ---- inbound: business rules -------------------------------------------


def test_respects_allowed_operators(ops):
    _alice, bob = ops
    src = webhook_source_create(name="Pool", operator_ids=[bob.id])
    for i in range(3):
        assert _post(src, {"name": f"N{i}", "phone": f"90100000{i}"}).status_code == 201
    assert set(Lead.objects.values_list("operator_id", flat=True)) == {bob.id}


@override_settings(LEADS_REQUIRE_OPEN_SHIFT=True)
def test_respects_availability_and_falls_back_to_pool(src, ops):
    _alice, bob = ops
    s = attendance_settings_get()
    s.enforce_daily_checkin = True
    s.save(update_fields=["enforce_daily_checkin"])

    _post(src, {"name": "A", "phone": "901000001"})
    lead = Lead.objects.get()
    assert lead.operator_id is None and lead.status == LeadStatus.NEW

    AttendanceLog.objects.create(operator=bob, checked_in_at=timezone.now())
    _post(src, {"name": "B", "phone": "901000002"})
    assert Lead.objects.get(phone="+998901000002").operator_id == bob.id


def test_terminal_lead_with_same_phone_gets_fresh_lead(src):
    Lead.objects.create(full_name="Closed", phone="+998901234567", status=LeadStatus.LOST)
    assert _post(src, LEADPIXEL_BODY).json()["result"] == "created"
    assert Lead.objects.count() == 2


def test_invalid_phone_goes_to_needs_review(src):
    r = _post(src, {"name": "Kimdir", "phone": "12-34"})
    assert r.status_code == 201
    assert r.json()["result"] == "needs_review"
    lead = Lead.objects.get()
    assert lead.phone_invalid and lead.needs_review and lead.operator_id is None


def test_hot_source_sets_hot_until(ops):
    src = webhook_source_create(name="Hot", is_hot=True, hot_sla_minutes=7)
    before = timezone.now()
    _post(src, {"name": "A", "phone": "901000001"})
    delta = (Lead.objects.get().hot_until - before).total_seconds()
    assert 6 * 60 < delta <= 7 * 60 + 5


def test_webhook_lead_never_enqueues_sheet_writeback(src, ops, django_capture_on_commit_callbacks):
    with django_capture_on_commit_callbacks(execute=True):
        _post(src, {"name": "A", "phone": "901000001"})
    lead = Lead.objects.get()
    assert lead.operator_id is not None
    assert not SheetWritebackJob.objects.filter(lead=lead).exists()


# ---- Google sync paths / health / manager API ---------------------------


def test_sync_all_and_hot_sync_skip_webhook_sources(ops):
    webhook_source_create(name="Hot webhook", is_hot=True)
    from apps.leads.integrations.google_sheets import sync as sync_mod

    seen: list[int] = []

    def fake_sync_one(*, client, sheet_source, force_full_scan=False):
        seen.append(sheet_source.id)
        return sync_mod.SyncResult(sheet_source.id, read=0, imported=0, skipped=0, errors=0, max_row=0)

    hot_sheet = SheetSource.objects.create(name="Hot sheet", spreadsheet_id="S", gid=5, is_hot=True)
    with patch.object(sync_mod, "GoogleSheetsClient", MagicMock()), patch.object(
        sync_mod, "sync_one", side_effect=fake_sync_one
    ):
        sync_mod.sync_all()
        sync_mod.sync_all(hot_only=True)
    assert seen == [hot_sheet.id, hot_sheet.id]


def test_sync_now_and_reset_watermark_refuse_webhook(src):
    c = _mgr_client()
    with patch("apps.leads.integrations.google_sheets.sync.GoogleSheetsClient") as gsc:
        r1 = c.post(f"/api/sheet-sources/{src.id}/sync-now/")
        r2 = c.post(f"/api/sheet-sources/{src.id}/reset-watermark/", {"row": 0}, format="json")
    assert r1.status_code == 400 and r1.json()["reason"] == "webhook_source"
    assert r2.status_code == 400
    gsc.assert_not_called()


def test_health_overview_and_stats_for_webhook_source(src):
    _post(src, {"name": "A", "phone": "901000001"})
    c = _mgr_client()
    row = next(s for s in c.get("/api/sheet-sources/health-overview/").json()["sources"] if s["id"] == src.id)
    assert row["kind"] == "webhook" and row["is_healthy"] is True
    assert row["writeback_enabled"] is False and row["leads_total"] == 1
    assert row["webhook"]["requests_24h"] == 1
    assert row["webhook"]["last_request_outcome"] == "created"
    r = c.get(f"/api/sheet-sources/{src.id}/stats/")
    assert r.status_code == 200 and r.json()["is_healthy"] is True


def test_sheet_source_api_masks_webhook_key(src):
    c = _mgr_client()
    data = c.get(f"/api/sheet-sources/{src.id}/").json()
    assert data["kind"] == "webhook"
    assert data["webhook_url"].endswith(f"/api/integrations/leads/{src.webhook_token}/")
    assert data["webhook_api_key"] == f"••••{src.webhook_api_key[-4:]}"
    assert src.webhook_api_key not in json.dumps(data)
    assert "outbound_config" not in data

    r = c.patch(f"/api/sheet-sources/{src.id}/", {"name": "Site"}, format="json")
    assert r.status_code == 200, r.content
    src.refresh_from_db()
    assert src.name == "Site"


def test_sheet_source_api_create_and_rotate_reveal_key_once():
    c = _mgr_client()
    r = c.post("/api/sheet-sources/", {"name": "LP2", "kind": "webhook"}, format="json")
    assert r.status_code == 201, r.content
    src = SheetSource.objects.get(name="LP2")
    assert r.json()["webhook_api_key"] == src.webhook_api_key and len(src.webhook_api_key) >= 40

    old = src.webhook_api_key
    r = c.post(f"/api/sheet-sources/{src.id}/rotate-webhook-key/")
    src.refresh_from_db()
    assert r.status_code == 200 and src.webhook_api_key != old
    assert r.json()["webhook_api_key"] == src.webhook_api_key
    assert c.get(f"/api/sheet-sources/{src.id}/").json()["webhook_api_key"].startswith("••••")
    assert _post(src, LEADPIXEL_BODY, key=old).status_code == 401

    r = c.post("/api/sheet-sources/", {"name": "S", "column_map": {"phone": "p", "full_name": "n"}}, format="json")
    assert r.status_code == 400 and "spreadsheet_id" in r.json() and "gid" in r.json()


# ---- commands --------------------------------------------------------------


def test_create_webhook_source_command_prints_url_and_key(ops):
    out = io.StringIO()
    call_command(
        "create_webhook_source", "--name", "LeadPixel (Meta)", "--hot", "--hot-sla", "10",
        "--operators", f"{ops[1].id}", stdout=out,
    )
    src = SheetSource.objects.get(kind=SheetSourceKind.WEBHOOK)
    assert src.is_hot and src.hot_sla_minutes == 10
    assert list(src.allowed_operators.values_list("id", flat=True)) == [ops[1].id]
    assert f"URL: /api/integrations/leads/{src.webhook_token}/" in out.getvalue()
    assert f"X-API-Key: {src.webhook_api_key}" in out.getvalue()
    assert len(src.webhook_api_key) >= 40

    old_token, old_key = src.webhook_token, src.webhook_api_key
    call_command("create_webhook_source", "--rotate", str(src.id), stdout=io.StringIO())
    out = io.StringIO()
    call_command("create_webhook_source", "--rotate-key", str(src.id), stdout=out)
    src.refresh_from_db()
    assert src.webhook_token != old_token and src.webhook_api_key != old_key
    assert f"X-API-Key: {src.webhook_api_key}" in out.getvalue()


def test_two_webhook_sources_do_not_collide_on_sheet_unique_key(ops):
    a = webhook_source_create(name="A")
    b = webhook_source_create(name="B")
    assert a.spreadsheet_id == b.spreadsheet_id == "" and a.gid == b.gid == 0
    assert a.webhook_token != b.webhook_token and a.webhook_api_key != b.webhook_api_key


def test_analytics_sales_by_source_counts_webhook_leads(src):
    from apps.analytics.selectors import sales_by_source

    _post(src, {"name": "A", "phone": "901000001"})
    _post(src, {"name": "B", "phone": "901000002"})
    row = next(r for r in sales_by_source() if r["sheet_source_id"] == src.id)
    assert row["leads_count"] == 2

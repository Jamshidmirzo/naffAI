"""
Webhook lead intake + «статусы обратно» (2026-10-15, LeadPixel → «Своя CRM»).

Pins:
  * POST /api/integrations/leads/<token>/ — 404 for a wrong token, GET ping,
    flat JSON / Meta field_data / entry-changes envelope / arrays / forms;
  * webhook leads are routed like a sheet row of the source (operator pool,
    availability, hot SLA), merged into an active lead with the same phone,
    deduplicated by external_id, invalid phones → needs_review;
  * Google sync / hot sync / sync-now never touch webhook sources, health
    endpoints work without Google;
  * LeadOutboundEvent is queued only for webhook-source leads (status, sale,
    return), and `process_lead_outbound --once` delivers only for enabled
    sources;
  * `create_webhook_source` prints the intake path.
"""

from __future__ import annotations

import io
import json
from decimal import Decimal
from unittest.mock import MagicMock, patch

import pytest
from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.core.management import call_command
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
    LeadOutboundEvent,
    LeadSource,
    LeadStatus,
    SheetSource,
    SheetSourceKind,
    SheetWritebackJob,
)
from apps.leads.services import (
    lead_convert_to_sale,
    lead_create_from_sheet_row,
    lead_update_status,
)
from apps.operators.models import Operator, OperatorStatus
from apps.users.models import Profile, Role

pytestmark = pytest.mark.django_db

User = get_user_model()


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


def _post(source, body, **kw):
    c = APIClient()
    return c.post(_url(source), data=json.dumps(body), content_type="application/json", **kw)


def _mgr_client() -> APIClient:
    user = User.objects.create_user(username="mgr", password="mgrpass1")
    Profile.objects.create(user=user, role=Role.MANAGER)
    c = APIClient()
    c.force_authenticate(user=user)
    return c


# ---- inbound: routing / auth -------------------------------------------


def test_wrong_token_and_inactive_source_404(src):
    c = APIClient()
    assert c.post("/api/integrations/leads/nope/", {"phone": "901234567"}, format="json").status_code == 404
    src.active = False
    src.save(update_fields=["active"])
    assert _post(src, {"phone": "901234567"}).status_code == 404
    assert not Lead.objects.exists()


def test_sheet_source_has_no_webhook(sheet):
    # Google-шит без токена недоступен по webhook-адресу ни под каким токеном.
    sheet.webhook_token = "sheet-token"
    sheet.save(update_fields=["webhook_token"])
    r = APIClient().post("/api/integrations/leads/sheet-token/", {"phone": "901234567"}, format="json")
    assert r.status_code == 404


def test_get_ping(src):
    r = APIClient().get(_url(src))
    assert r.status_code == 200
    assert r.json() == {"ok": True, "source": "LeadPixel (Meta)"}


def test_payload_too_large(src):
    r = _post(src, {"name": "A", "phone": "901234567", "junk": "x" * (300 * 1024)})
    assert r.status_code == 413
    assert not Lead.objects.exists()


# ---- inbound: formats ---------------------------------------------------


def test_flat_json_creates_assigned_lead(src, ops):
    r = _post(
        src,
        {"name": "Ali", "phone": "+998 90 123 45 67", "product": "iPhone 15", "lead_id": "L1",
         "campaign_name": "Oktabr", "custom_q": "ertaga"},
    )
    assert r.status_code == 200, r.content
    body = r.json()
    assert body["ok"] is True and body["result"] == "created"
    lead = Lead.objects.get(pk=body["lead_id"])
    assert lead.source == LeadSource.WEBHOOK
    assert lead.sheet_source_id == src.id
    assert lead.sheet_row_index is None
    assert lead.phone == "+998901234567"
    assert lead.full_name == "Ali" and lead.product_hint == "iPhone 15"
    assert lead.metadata["ad"] == {"lead_id": "L1", "campaign_name": "Oktabr"}
    assert lead.metadata["extra"] == {"custom_q": "ertaga"}
    assert lead.operator_id in {ops[0].id, ops[1].id}
    assert lead.status == LeadStatus.ASSIGNED
    ev = InboundLeadEvent.objects.get()
    assert (ev.outcome, ev.external_id, ev.lead_id) == ("created", "L1", lead.id)
    assert ev.payload["name"] == "Ali"
    src.refresh_from_db()
    assert src.last_synced_at is not None


def test_meta_field_data(src):
    r = _post(
        src,
        {
            "id": "1500100",
            "form_name": "Forma",
            "field_data": [
                {"name": "full_name", "values": ["Dilshod"]},
                {"name": "phone_number", "values": ["998901112233"]},
                {"name": "qanday_telefon_xarid_qilmoqchisiz?", "values": ["S24"]},
            ],
        },
    )
    assert r.status_code == 200, r.content
    lead = Lead.objects.get()
    assert (lead.full_name, lead.phone, lead.product_hint) == ("Dilshod", "+998901112233", "S24")
    assert lead.metadata["ad"]["id"] == "1500100"


def test_meta_envelope_entry_changes_is_batch(src):
    body = {
        "object": "page",
        "entry": [
            {"changes": [{"value": {"leadgen_id": "a1", "full_name": "A", "phone": "901000001"}}]},
            {"changes": [{"value": {"leadgen_id": "a2", "full_name": "B", "phone": "901000002"}}]},
        ],
    }
    r = _post(src, body)
    assert r.status_code == 200, r.content
    assert [x["result"] for x in r.json()["results"]] == ["created", "created"]
    assert Lead.objects.count() == 2


def test_array_body_mixed_results(src):
    r = _post(src, [{"name": "A", "phone": "901000001"}, {"foo": "bar"}])
    assert r.status_code == 200
    res = r.json()["results"]
    assert res[0]["result"] == "created" and res[0]["ok"] is True
    assert res[1]["result"] == "invalid" and res[1]["ok"] is False
    assert Lead.objects.count() == 1
    assert InboundLeadEvent.objects.filter(outcome="invalid").count() == 1


def test_form_encoded(src):
    c = APIClient()
    r = c.post(_url(src), data="Name=Aziz&Phone=%2B998901234500&utm_source=fb",
               content_type="application/x-www-form-urlencoded")
    assert r.status_code == 200, r.content
    lead = Lead.objects.get()
    assert (lead.full_name, lead.phone) == ("Aziz", "+998901234500")
    assert lead.metadata["ad"] == {"utm_source": "fb"}


def test_multipart_form(src):
    r = APIClient().post(_url(src), {"name": "Mansur", "phone": "901234511"}, format="multipart")
    assert r.status_code == 200, r.content
    assert Lead.objects.get().full_name == "Mansur"


def test_unparsable_and_empty_bodies_are_400_and_journaled(src):
    c = APIClient()
    r = c.post(_url(src), data="{not json", content_type="application/json")
    assert r.status_code == 400 and r.json()["ok"] is False
    r = _post(src, {"foo": "bar"})
    assert r.status_code == 400
    assert r.json() == {"ok": False, "error": "no phone and no name in payload"}
    assert InboundLeadEvent.objects.filter(outcome="invalid").count() == 2
    assert not Lead.objects.exists()


# ---- inbound: business rules -------------------------------------------


def test_respects_allowed_operators(ops):
    _alice, bob = ops
    src = webhook_source_create(name="Pool", operator_ids=[bob.id])
    for i in range(3):
        assert _post(src, {"name": f"N{i}", "phone": f"90100000{i}"}).status_code == 200
    assert set(Lead.objects.values_list("operator_id", flat=True)) == {bob.id}


@override_settings(LEADS_REQUIRE_OPEN_SHIFT=True)
def test_respects_availability_and_falls_back_to_pool(src, ops):
    _alice, bob = ops
    s = attendance_settings_get()
    s.enforce_daily_checkin = True
    s.save(update_fields=["enforce_daily_checkin"])

    # Никто не на смене → лид остаётся в пуле (new, без оператора).
    _post(src, {"name": "A", "phone": "901000001"})
    lead = Lead.objects.get()
    assert lead.operator_id is None and lead.status == LeadStatus.NEW

    AttendanceLog.objects.create(operator=bob, checked_in_at=timezone.now())
    _post(src, {"name": "B", "phone": "901000002"})
    assert Lead.objects.get(phone="+998901000002").operator_id == bob.id


def test_merge_into_active_lead_with_same_phone(src, sheet, ops):
    existing, _ = lead_create_from_sheet_row(
        sheet_source=sheet, row_index=2, raw_row={"name": "Old", "phone": "901234567"}
    )
    op_before = existing.operator_id
    r = _post(src, {"name": "New name", "phone": "+998901234567", "product": "S24", "leadgen_id": "g1"})
    assert r.json()["result"] == "merged"
    assert r.json()["lead_id"] == existing.id
    existing.refresh_from_db()
    assert Lead.objects.count() == 1
    assert existing.sheet_source_id == sheet.id  # hard fields untouched
    assert existing.operator_id == op_before
    assert existing.product_hint == "S24"
    trail = existing.metadata["duplicate_webhook_events"]
    assert trail[0]["source_id"] == src.id and trail[0]["external_id"] == "g1"


def test_terminal_lead_with_same_phone_gets_fresh_lead(src):
    Lead.objects.create(full_name="Closed", phone="+998901234567", status=LeadStatus.LOST)
    assert _post(src, {"name": "Back", "phone": "901234567"}).json()["result"] == "created"
    assert Lead.objects.count() == 2


def test_repeat_external_id_is_duplicate(src):
    r1 = _post(src, {"name": "A", "phone": "901000001", "leadgen_id": "same"})
    r2 = _post(src, {"name": "A", "phone": "901000009", "leadgen_id": "same"})
    assert r2.status_code == 200
    assert r2.json() == {"ok": True, "lead_id": r1.json()["lead_id"], "result": "duplicate"}
    assert Lead.objects.count() == 1
    assert InboundLeadEvent.objects.filter(outcome="duplicate").count() == 1


def test_invalid_phone_goes_to_needs_review(src):
    r = _post(src, {"name": "Kimdir", "phone": "12-34"})
    assert r.status_code == 200
    assert r.json()["result"] == "needs_review"
    lead = Lead.objects.get()
    assert lead.phone_invalid and lead.needs_review
    assert lead.status == LeadStatus.NEEDS_REVIEW
    assert lead.operator_id is None


def test_hot_source_sets_hot_until(ops):
    src = webhook_source_create(name="Hot", is_hot=True, hot_sla_minutes=7)
    before = timezone.now()
    _post(src, {"name": "A", "phone": "901000001"})
    lead = Lead.objects.get()
    assert lead.hot_until is not None
    delta = (lead.hot_until - before).total_seconds()
    assert 6 * 60 < delta <= 7 * 60 + 5


def test_webhook_lead_never_enqueues_sheet_writeback(src, ops, django_capture_on_commit_callbacks):
    with django_capture_on_commit_callbacks(execute=True):
        _post(src, {"name": "A", "phone": "901000001"})
    lead = Lead.objects.get()
    assert lead.operator_id is not None  # lead_auto_assign scheduled a writeback…
    assert not SheetWritebackJob.objects.filter(lead=lead).exists()  # …but it was dropped


# ---- Google sync paths skip webhook sources ----------------------------


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
    r = c.get("/api/sheet-sources/health-overview/")
    assert r.status_code == 200, r.content
    row = next(s for s in r.json()["sources"] if s["id"] == src.id)
    assert row["kind"] == "webhook"
    assert row["is_healthy"] is True
    assert row["writeback_enabled"] is False
    assert row["leads_total"] == 1
    assert row["webhook"]["requests_24h"] == 1
    assert row["webhook"]["last_request_outcome"] == "created"
    assert row["last_synced_at"] is not None

    r = c.get(f"/api/sheet-sources/{src.id}/stats/")
    assert r.status_code == 200 and r.json()["is_healthy"] is True


def test_sheet_source_api_exposes_url_and_masks_key(src):
    src.outbound_config = {"url": "https://lp.example/api", "api_key": "secret-1234", "enabled": False}
    src.save(update_fields=["outbound_config"])
    c = _mgr_client()
    r = c.get(f"/api/sheet-sources/{src.id}/")
    data = r.json()
    assert data["kind"] == "webhook"
    assert data["webhook_url"].endswith(f"/api/integrations/leads/{src.webhook_token}/")
    assert data["webhook_url"].startswith("http")
    assert data["outbound_config"]["api_key"] == "••••1234"
    assert "secret" not in json.dumps(data)

    # PATCH без spreadsheet_id/gid/column_map; маска ключ не затирает.
    r = c.patch(
        f"/api/sheet-sources/{src.id}/",
        {"name": "LP", "is_hot": True, "outbound_config": {"api_key": "••••1234", "enabled": True}},
        format="json",
    )
    assert r.status_code == 200, r.content
    src.refresh_from_db()
    assert src.name == "LP" and src.is_hot
    assert src.outbound_config["api_key"] == "secret-1234"
    assert src.outbound_config["enabled"] is True
    assert src.kind == SheetSourceKind.WEBHOOK and src.spreadsheet_id == ""


def test_sheet_source_api_create_webhook_and_sheet_still_requires_ids():
    c = _mgr_client()
    r = c.post("/api/sheet-sources/", {"name": "LP2", "kind": "webhook"}, format="json")
    assert r.status_code == 201, r.content
    assert r.json()["webhook_url"]
    r = c.post("/api/sheet-sources/", {"name": "S", "column_map": {"phone": "p", "full_name": "n"}}, format="json")
    assert r.status_code == 400
    assert "spreadsheet_id" in r.json() and "gid" in r.json()


# ---- outbound queue -----------------------------------------------------


def _webhook_lead(src) -> Lead:
    r = _post(src, {"name": "A", "phone": "901000001", "leadgen_id": "LG-1"})
    return Lead.objects.get(pk=r.json()["lead_id"])


def test_status_change_enqueues_only_for_webhook_leads(src, sheet, ops, django_capture_on_commit_callbacks):
    with django_capture_on_commit_callbacks(execute=True):
        lead = _webhook_lead(src)
    first = LeadOutboundEvent.objects.get()
    assert first.kind == "status" and first.payload["status"] == LeadStatus.ASSIGNED
    assert first.payload["external_id"] == "LG-1"

    sheet_lead, _ = lead_create_from_sheet_row(
        sheet_source=sheet, row_index=2, raw_row={"name": "S", "phone": "909999999"}
    )
    with django_capture_on_commit_callbacks(execute=True):
        lead_update_status(lead=lead, status=LeadStatus.NO_ANSWER)
        lead_update_status(lead=sheet_lead, status=LeadStatus.NO_ANSWER)
    events = list(LeadOutboundEvent.objects.order_by("id"))
    assert len(events) == 2
    assert all(e.lead_id == lead.id for e in events)
    p = events[-1].payload
    assert p["status"] == LeadStatus.NO_ANSWER and p["currency"] == "UZS"
    assert p["phone"] == "+998901000001" and p["operator"] in {"Alice", "Bob"}


def test_sale_and_return_enqueue_once(src, ops, django_capture_on_commit_callbacks):
    from apps.sales.services import sale_mark_returned

    channel = Channel.objects.create(name="Alif")
    with django_capture_on_commit_callbacks(execute=True):
        lead = _webhook_lead(src)
    with django_capture_on_commit_callbacks(execute=True):
        sale = lead_convert_to_sale(
            lead=lead,
            sale_data={
                "imei": "490154203237518",
                "phone_model": "iPhone 15",
                "channel_id": channel.id,
                "amount": Decimal("4500000"),
                "discount": Decimal("500000"),
                # тот же телефон → sale_create сам найдёт лид и тоже
                # проставит WON — дублей событий быть не должно.
                "client_phone": "+998901000001",
            },
        )
    kinds = list(LeadOutboundEvent.objects.order_by("id").values_list("kind", "dedupe_key"))
    assert kinds == [("status", "status:assigned"), ("status", "status:won"), ("sale", f"sale:{sale.id}")]
    sale_ev = LeadOutboundEvent.objects.get(kind="sale")
    assert sale_ev.payload["amount_uzs"] == 4_000_000
    assert sale_ev.payload["sale_id"] == sale.id

    with django_capture_on_commit_callbacks(execute=True):
        sale_mark_returned(sale=sale, reason="brak")
        sale_mark_returned(sale=sale, reason="brak")
    assert LeadOutboundEvent.objects.filter(kind="sale_returned").count() == 1


def test_pending_sale_is_reported_on_confirm(src, ops, django_capture_on_commit_callbacks):
    from apps.sales.models import SaleStatus
    from apps.sales.services import sale_confirm, sale_create

    channel = Channel.objects.create(name="Alif")
    with django_capture_on_commit_callbacks(execute=True):
        lead = _webhook_lead(src)
    sale = sale_create(
        imei="490154203237518",
        phone_model="X",
        channel_id=channel.id,
        operator_id=lead.operator_id,
        amount=Decimal("2000000"),
    )
    # Pending-продажу с фото договора в тесте не собрать — переводим руками:
    # продажа на подтверждении, привязана к лиду.
    type(sale).objects.filter(pk=sale.pk).update(status=SaleStatus.PENDING, lead=lead)
    sale.refresh_from_db()
    with django_capture_on_commit_callbacks(execute=True):
        lead_update_status(lead=lead, status=LeadStatus.WON)
    assert not LeadOutboundEvent.objects.filter(kind="sale").exists()
    with django_capture_on_commit_callbacks(execute=True):
        sale_confirm(sale=sale)
    ev = LeadOutboundEvent.objects.get(kind="sale")
    assert ev.payload["amount_uzs"] == 2_000_000


def test_sheet_lead_sale_enqueues_nothing(sheet, ops, django_capture_on_commit_callbacks):
    channel = Channel.objects.create(name="Alif")
    lead, _ = lead_create_from_sheet_row(
        sheet_source=sheet, row_index=2, raw_row={"name": "S", "phone": "909999999"}
    )
    with django_capture_on_commit_callbacks(execute=True):
        lead_convert_to_sale(
            lead=lead,
            sale_data={"imei": "490154203237518", "phone_model": "X", "channel_id": channel.id,
                       "amount": Decimal("1000000")},
        )
    assert not LeadOutboundEvent.objects.exists()


def test_process_lead_outbound_skips_disabled_and_delivers_enabled(ops, django_capture_on_commit_callbacks):
    disabled = webhook_source_create(name="Off")
    enabled = webhook_source_create(name="On")
    enabled.outbound_config = {"url": "https://lp.example/hook", "api_key": "k1", "enabled": True}
    enabled.save(update_fields=["outbound_config"])
    with django_capture_on_commit_callbacks(execute=True):
        _post(disabled, {"name": "A", "phone": "901000001"})
        _post(enabled, {"name": "B", "phone": "901000002"})
    assert LeadOutboundEvent.objects.count() == 2

    ok = MagicMock(status_code=200, text="ok")
    with patch("httpx.post", return_value=ok) as post:
        out = io.StringIO()
        call_command("process_lead_outbound", "--once", stdout=out)
    assert post.call_count == 1
    args, kwargs = post.call_args
    assert args[0] == "https://lp.example/hook"
    assert kwargs["headers"]["Authorization"] == "Bearer k1"
    assert kwargs["json"]["lead_id"] == Lead.objects.get(phone="+998901000002").id

    on_ev = LeadOutboundEvent.objects.get(source=enabled)
    off_ev = LeadOutboundEvent.objects.get(source=disabled)
    assert on_ev.delivered_at is not None and on_ev.attempts == 1
    assert off_ev.delivered_at is None and off_ev.attempts == 0 and off_ev.next_try_at is None


def test_process_lead_outbound_retries_with_backoff(ops, django_capture_on_commit_callbacks):
    src = webhook_source_create(name="On")
    src.outbound_config = {"url": "https://lp.example/hook", "enabled": True}
    src.save(update_fields=["outbound_config"])
    with django_capture_on_commit_callbacks(execute=True):
        _post(src, {"name": "B", "phone": "901000002"})
    with patch("httpx.post", return_value=MagicMock(status_code=503, text="down")) as post:
        call_command("process_lead_outbound", "--once", stdout=io.StringIO())
        # Повторный прогон сразу — событие ждёт backoff, не шлётся.
        call_command("process_lead_outbound", "--once", stdout=io.StringIO())
    assert post.call_count == 1
    assert "Authorization" not in post.call_args.kwargs["headers"]
    ev = LeadOutboundEvent.objects.get()
    assert ev.attempts == 1 and ev.delivered_at is None
    assert "503" in ev.last_error
    assert ev.next_try_at > timezone.now()


# ---- management command --------------------------------------------------


def test_create_webhook_source_command(ops):
    out = io.StringIO()
    call_command(
        "create_webhook_source",
        "--name", "LeadPixel (Meta)",
        "--hot", "--hot-sla", "10",
        "--operators", f"{ops[1].id}",
        stdout=out,
    )
    src = SheetSource.objects.get(kind=SheetSourceKind.WEBHOOK)
    assert src.is_hot and src.hot_sla_minutes == 10
    assert list(src.allowed_operators.values_list("id", flat=True)) == [ops[1].id]
    assert src.distribution_mode == DistributionMode.ALIAS_OR_ROUND_ROBIN
    assert f"/api/integrations/leads/{src.webhook_token}/" in out.getvalue()

    old = src.webhook_token
    out = io.StringIO()
    call_command("create_webhook_source", "--rotate", str(src.id), stdout=out)
    src.refresh_from_db()
    assert src.webhook_token != old
    assert f"/api/integrations/leads/{src.webhook_token}/" in out.getvalue()


def test_two_webhook_sources_do_not_collide_on_sheet_unique_key(ops):
    a = webhook_source_create(name="A")
    b = webhook_source_create(name="B")
    assert a.spreadsheet_id == b.spreadsheet_id == "" and a.gid == b.gid == 0
    assert a.webhook_token != b.webhook_token


def test_analytics_sales_by_source_counts_webhook_leads(src):
    from apps.analytics.selectors import sales_by_source

    _post(src, {"name": "A", "phone": "901000001"})
    _post(src, {"name": "B", "phone": "901000002"})
    row = next(r for r in sales_by_source() if r["sheet_source_id"] == src.id)
    assert row["leads_count"] == 2

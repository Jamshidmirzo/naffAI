"""
Unit tests for the sheet-source wizard preview helpers.

We avoid hitting Google Sheets by monkey-patching `GoogleSheetsClient`;
the real network integration is verified manually via the demo smoke
test.
"""

from __future__ import annotations

from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from apps.leads.integrations.google_sheets.preview import (
    PreviewError,
    fetch_sheet_preview,
    parse_spreadsheet_url,
    suggest_column_map,
    suggest_writeback_columns,
)
from apps.leads.models import SheetSource
from apps.users.models import Profile, Role

User = get_user_model()


# ---------- URL parser ------------------------------------------------------


def test_parse_url_with_gid():
    sid, gid = parse_spreadsheet_url(
        "https://docs.google.com/spreadsheets/d/10fFZQU-kw3h3X0XJGXUOYQo05nsOAa9DDD82SN8wADM/edit?gid=0#gid=0"
    )
    assert sid == "10fFZQU-kw3h3X0XJGXUOYQo05nsOAa9DDD82SN8wADM"
    assert gid == 0


def test_parse_url_defaults_to_gid_0():
    sid, gid = parse_spreadsheet_url(
        "https://docs.google.com/spreadsheets/d/ABCD1234/edit"
    )
    assert sid == "ABCD1234"
    assert gid == 0


def test_parse_url_with_hash_only_gid():
    sid, gid = parse_spreadsheet_url(
        "https://docs.google.com/spreadsheets/d/XYZ/edit#gid=456"
    )
    assert sid == "XYZ"
    assert gid == 456


def test_parse_url_rejects_garbage():
    with pytest.raises(PreviewError):
        parse_spreadsheet_url("not a url")


def test_parse_url_rejects_empty():
    with pytest.raises(PreviewError):
        parse_spreadsheet_url("")


# ---------- suggest_column_map (real zedmobile headers) --------------------


ZEDMOBILE_HEADERS = [
    "phone_number",
    "ismingiz_nima?",
    "qanday_telefon_xarid_qilmoqchisiz?",
    "plastik_kartangiz_bormi?",
    "qoshimcha_raqam_qoldirsangiz.",
    "crm",
    "created_time",
]


def test_suggest_column_map_hits_zedmobile_headers():
    m = suggest_column_map(ZEDMOBILE_HEADERS)
    assert m["phone"] == "phone_number"
    assert m["full_name"] == "ismingiz_nima?"
    assert m["product_hint"] == "qanday_telefon_xarid_qilmoqchisiz?"
    assert m["has_card"] == "plastik_kartangiz_bormi?"
    assert m["extra_phone"] == "qoshimcha_raqam_qoldirsangiz."


def test_suggest_column_map_empty_headers():
    m = suggest_column_map([])
    assert all(v is None for v in m.values())


def test_suggest_column_map_english_headers():
    m = suggest_column_map(["Full Name", "Phone", "Product", "Has Card"])
    assert m["phone"] == "Phone"
    assert m["full_name"] == "Full Name"
    assert m["product_hint"] == "Product"
    assert m["has_card"] == "Has Card"


def test_suggest_column_map_no_duplicate_assignment():
    # phone and extra_phone both mention "raqam" — must not both grab the
    # same header.
    headers = ["phone_number", "qoshimcha_raqam"]
    m = suggest_column_map(headers)
    assert m["phone"] == "phone_number"
    assert m["extra_phone"] == "qoshimcha_raqam"


# ---------- suggest_writeback_columns --------------------------------------


def test_suggest_writeback_zedmobile():
    wb = suggest_writeback_columns(ZEDMOBILE_HEADERS)
    # `crm` is header #6 -> column F
    assert wb["status_col"] == "F"
    # `created_time` -> updated_at
    assert wb["updated_at_col"] == "G"
    # no operator / comment header in this sheet
    assert wb["operator_col"] is None
    assert wb["comment_col"] is None


def test_suggest_writeback_full_house():
    headers = ["name", "phone", "status", "operator", "updated_at", "comment"]
    wb = suggest_writeback_columns(headers)
    assert wb["status_col"] == "C"
    assert wb["operator_col"] == "D"
    assert wb["updated_at_col"] == "E"
    assert wb["comment_col"] == "F"


# ---------- fetch_sheet_preview (mocked client) ----------------------------


class _FakeClient:
    def __init__(self, worksheet="Leads", rows=None):
        self._worksheet = worksheet
        self._rows = rows or []

    def worksheet_name_by_gid(self, sid, gid):
        return self._worksheet

    def raw_values(self, sid, rng):
        return self._rows


def test_fetch_sheet_preview_basic():
    fake = _FakeClient(
        worksheet="Leads",
        rows=[
            ["phone_number", "ismingiz_nima?", "crm"],
            ["+998900000001", "Ali", ""],
            ["+998900000002", "Vali", "OK"],
        ],
    )
    with patch(
        "apps.leads.integrations.google_sheets.preview.GoogleSheetsClient",
        return_value=fake,
    ):
        r = fetch_sheet_preview("SID", 0)
    assert r["sheet_title"] == "Leads"
    assert r["headers"] == ["phone_number", "ismingiz_nima?", "crm"]
    assert r["total_rows"] == 2
    assert len(r["sample_rows"]) == 2


def test_fetch_sheet_preview_worksheet_not_found():
    fake = _FakeClient(worksheet=None)
    with patch(
        "apps.leads.integrations.google_sheets.preview.GoogleSheetsClient",
        return_value=fake,
    ):
        with pytest.raises(PreviewError):
            fetch_sheet_preview("SID", 999)


def test_fetch_sheet_preview_403_message():
    fake = _FakeClient(worksheet="Leads")

    def boom(*a, **kw):
        raise Exception("HTTP 403 permission denied")

    fake.raw_values = boom  # type: ignore[method-assign]
    with patch(
        "apps.leads.integrations.google_sheets.preview.GoogleSheetsClient",
        return_value=fake,
    ):
        with pytest.raises(PreviewError) as exc:
            fetch_sheet_preview("SID", 0)
    assert "Нет доступа" in str(exc.value) or "доступ" in str(exc.value).lower()


# ---------- API endpoints --------------------------------------------------


def _team_lead():
    u = User.objects.create_user(username="tl", password="pw123456")
    Profile.objects.create(user=u, role=Role.TEAM_LEAD)
    return u


@pytest.mark.django_db
def test_preview_api_from_url_returns_suggestions():
    fake = _FakeClient(
        worksheet="Leads",
        rows=[
            ["phone_number", "ismingiz_nima?", "crm"],
            ["+998900000001", "Ali", ""],
        ],
    )
    tl = _team_lead()
    c = APIClient()
    c.force_authenticate(user=tl)
    with patch(
        "apps.leads.integrations.google_sheets.preview.GoogleSheetsClient",
        return_value=fake,
    ):
        r = c.post(
            "/api/sheet-sources/preview/",
            {
                "spreadsheet_url": "https://docs.google.com/spreadsheets/d/SID/edit?gid=0"
            },
            format="json",
        )
    assert r.status_code == 200, r.content
    assert r.data["spreadsheet_id"] == "SID"
    assert r.data["gid"] == 0
    assert r.data["sheet_title"] == "Leads"
    assert r.data["suggested_column_map"]["phone"] == "phone_number"
    assert r.data["already_connected"] is None


@pytest.mark.django_db
def test_preview_api_detects_already_connected():
    SheetSource.objects.create(
        name="Existing",
        spreadsheet_id="SID",
        gid=0,
        column_map={"phone": "phone_number", "full_name": "ismingiz_nima?"},
    )
    fake = _FakeClient(
        worksheet="Leads",
        rows=[["phone_number", "ismingiz_nima?"], ["+998900000001", "Ali"]],
    )
    tl = _team_lead()
    c = APIClient()
    c.force_authenticate(user=tl)
    with patch(
        "apps.leads.integrations.google_sheets.preview.GoogleSheetsClient",
        return_value=fake,
    ):
        r = c.post(
            "/api/sheet-sources/preview/",
            {
                "spreadsheet_url": "https://docs.google.com/spreadsheets/d/SID/edit?gid=0"
            },
            format="json",
        )
    assert r.status_code == 200
    assert r.data["already_connected"] is not None
    assert r.data["already_connected"]["name"] == "Existing"


@pytest.mark.django_db
def test_preview_api_rejects_bad_url():
    tl = _team_lead()
    c = APIClient()
    c.force_authenticate(user=tl)
    r = c.post(
        "/api/sheet-sources/preview/", {"spreadsheet_url": "garbage"}, format="json"
    )
    assert r.status_code == 400


@pytest.mark.django_db
def test_sync_now_cooldown_returns_429():
    from django.utils import timezone

    src = SheetSource.objects.create(
        name="X",
        spreadsheet_id="SID",
        gid=0,
        column_map={"phone": "phone_number", "full_name": "ismingiz_nima?"},
        last_synced_at=timezone.now(),
    )
    tl = _team_lead()
    c = APIClient()
    c.force_authenticate(user=tl)
    r = c.post(f"/api/sheet-sources/{src.id}/sync-now/")
    assert r.status_code == 429


@pytest.mark.django_db
def test_stats_api_returns_health():
    src = SheetSource.objects.create(
        name="X",
        spreadsheet_id="SID",
        gid=0,
        column_map={"phone": "phone_number", "full_name": "ismingiz_nima?"},
    )
    tl = _team_lead()
    c = APIClient()
    c.force_authenticate(user=tl)
    r = c.get(f"/api/sheet-sources/{src.id}/stats/")
    assert r.status_code == 200, r.content
    assert r.data["id"] == src.id
    assert r.data["leads_total"] == 0
    assert r.data["is_healthy"] is False  # never synced

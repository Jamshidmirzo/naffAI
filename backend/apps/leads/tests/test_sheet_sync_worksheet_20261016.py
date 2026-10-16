"""
Sheet tab resolution (2026-10-16, prod incident «yangi target»).

The Google tab is «'Yengi target '» (trailing space); a form save trimmed
the stored name to «Yengi target», every sync hit «Unable to parse range»
(400) and new rows stopped importing. Pins:
  * the tab is found by gid first — a stale / trimmed stored name is ignored;
  * the stored name is the fallback when the gid is gone or metadata fails;
  * the API keeps leading / trailing spaces in worksheet_name;
  * Google 400 / 403 / 404 → a readable last_sync_error and a 400 from
    sync-now instead of a 500 with the raw URL;
  * writeback addresses the tab found by gid.
"""

from __future__ import annotations

from unittest.mock import MagicMock

import httpx
import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from apps.common.exceptions import ApplicationError
from apps.leads.integrations.google_sheets.client import resolve_worksheet_name
from apps.leads.integrations.google_sheets.sync import sync_one
from apps.leads.models import SheetSource
from apps.users.models import Profile, Role

TAB = "Yengi target "


def _source(**kw) -> SheetSource:
    defaults = dict(
        name="!! yangi terget !!",
        spreadsheet_id="sheet-yt",
        gid=1526806339,
        worksheet_name="Yengi target",  # trimmed by an old form save
        column_map={"full_name": "Name", "phone": "Phone"},
    )
    defaults.update(kw)
    return SheetSource.objects.create(**defaults)


def _client(*, by_gid=TAB, rows=None) -> MagicMock:
    client = MagicMock()
    client.worksheet_name_by_gid.return_value = by_gid
    client.get_rows.return_value = rows if rows is not None else []
    return client


def _google_error(code: int, body: str) -> httpx.HTTPStatusError:
    req = httpx.Request("GET", "https://sheets.googleapis.com/v4/spreadsheets/x/values/r")
    return httpx.HTTPStatusError("boom", request=req, response=httpx.Response(code, text=body, request=req))


@pytest.mark.django_db
def test_gid_wins_over_stale_stored_name():
    src = _source()
    client = _client(rows=[{"Name": "Ibrohim", "Phone": "+998900496606", "__row__": 2}])
    sync_one(client=client, sheet_source=src)
    client.get_rows.assert_called_once_with("sheet-yt", TAB)
    src.refresh_from_db()
    assert src.last_sync_error == ""


@pytest.mark.django_db
def test_stored_name_is_the_fallback():
    src = _source(worksheet_name="Old tab")
    assert resolve_worksheet_name(_client(by_gid=None), src) == "Old tab"
    failing = MagicMock()
    failing.worksheet_name_by_gid.side_effect = RuntimeError("metadata down")
    assert resolve_worksheet_name(failing, src) == "Old tab"


@pytest.mark.django_db
def test_nothing_resolves_is_a_clear_error():
    src = _source(worksheet_name="")
    with pytest.raises(ApplicationError, match="Worksheet not found"):
        sync_one(client=_client(by_gid=None), sheet_source=src)


@pytest.mark.django_db
@pytest.mark.parametrize(
    "code,body,expected",
    [
        (400, "Unable to parse range: 'Yengi target'!A1:ZZ", "не найдена в таблице"),
        (403, "The caller does not have permission", "Нет доступа к таблице"),
        (404, "Requested entity was not found.", "Таблица не найдена"),
    ],
)
def test_google_errors_become_readable(code, body, expected):
    src = _source()
    client = _client()
    client.get_rows.side_effect = _google_error(code, body)
    with pytest.raises(ApplicationError, match=expected):
        sync_one(client=client, sheet_source=src)
    src.refresh_from_db()
    assert expected in src.last_sync_error
    assert "googleapis" not in src.last_sync_error


@pytest.mark.django_db
def test_unknown_google_error_is_re_raised_raw():
    src = _source()
    client = _client()
    client.get_rows.side_effect = _google_error(500, "backend error")
    with pytest.raises(httpx.HTTPStatusError):
        sync_one(client=client, sheet_source=src)


@pytest.fixture
def manager_api(db):
    user = get_user_model().objects.create_user(username="mgr-sheets", password="x")
    Profile.objects.create(user=user, role=Role.MANAGER)
    api = APIClient()
    api.force_authenticate(user)
    return api


@pytest.mark.django_db
def test_api_keeps_spaces_in_worksheet_name(manager_api):
    src = _source(worksheet_name="")
    resp = manager_api.patch(f"/api/sheet-sources/{src.id}/", {"worksheet_name": TAB}, format="json")
    assert resp.status_code == 200, resp.content
    src.refresh_from_db()
    assert src.worksheet_name == TAB


@pytest.mark.django_db
def test_sync_now_returns_readable_400(manager_api, monkeypatch):
    src = _source()
    client = _client()
    client.get_rows.side_effect = _google_error(400, "Unable to parse range: 'Yengi target'!A1:ZZ")
    monkeypatch.setattr("apps.leads.integrations.google_sheets.sync.GoogleSheetsClient", lambda: client)
    resp = manager_api.post(f"/api/sheet-sources/{src.id}/sync-now/", {}, format="json")
    assert resp.status_code == 400
    assert "не найдена в таблице" in resp.json()["detail"]


@pytest.mark.django_db
def test_writeback_uses_tab_found_by_gid(monkeypatch):
    from apps.leads.models import Lead
    from apps.leads.services import lead_writeback_to_sheet

    src = _source(writeback_columns={"enabled": True})
    lead = Lead.objects.create(
        full_name="Ibrohim", phone="+998900496606", sheet_source=src, sheet_row_index=60,
        metadata={"writeback_start_col": "D"},
    )
    client = _client()
    monkeypatch.setattr("apps.leads.integrations.google_sheets.client.GoogleSheetsClient", lambda: client)
    lead_writeback_to_sheet(lead, raise_errors=True)
    assert client.update_cells.called
    written_range = str(client.update_cells.call_args)
    assert "'Yengi target '!" in written_range

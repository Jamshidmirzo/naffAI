"""
Thin wrapper around the Google Sheets v4 REST API.

Kept dependency-free at import time so `apps.leads` can be loaded on a
box that doesn't have the google-api-python-client extras installed —
`GoogleSheetsClient()` will only complain at construction time.

We deliberately go through the plain REST endpoint via `httpx` instead of
`gspread` so we don't add another dependency and stay in the async /
threadpool boundaries the rest of the project uses.
"""

from __future__ import annotations

import logging
import time
from pathlib import Path
from typing import Any

import httpx
from django.conf import settings

logger = logging.getLogger("leads.google_sheets")

_SHEETS_API_ROOT = "https://sheets.googleapis.com/v4/spreadsheets"
# Full read/write — writeback needs `values.update`. Reader-only scopes
# would 403 on PUT even if the service account has Editor rights.
_SCOPES = ["https://www.googleapis.com/auth/spreadsheets"]


class GoogleSheetsUnavailable(Exception):
    """Raised when the client cannot be constructed (missing key, offline, etc.)."""


class GoogleSheetsClient:
    """
    Minimal service-account-authorised Google Sheets client.

    Usage:
        client = GoogleSheetsClient()
        rows = client.get_rows(spreadsheet_id, worksheet_name)

    `rows` is a list of `dict`s (one per data row) with:
      - keys       = header names (row 1 of the sheet)
      - "__cells__" = the raw row cells in order (for positional column
                     lookups, e.g. Sheet 2's unnamed operator column)
      - "__row__"  = the 1-based sheet row index (2 for the first data row)
    """

    def __init__(self, *, credentials_path: str | None = None) -> None:
        self.credentials_path = (
            credentials_path or settings.GOOGLE_SHEETS_CREDENTIALS_JSON
        )
        if not self.credentials_path:
            raise GoogleSheetsUnavailable(
                "GOOGLE_SHEETS_CREDENTIALS_JSON is empty — cannot authenticate"
            )
        try:
            from google.auth.transport.requests import Request  # type: ignore[import-not-found]
            from google.oauth2 import service_account  # type: ignore[import-not-found]
        except ImportError as exc:
            raise GoogleSheetsUnavailable(
                "google-auth is not installed — `uv pip install google-auth`"
            ) from exc

        creds_path = Path(self.credentials_path)
        if not creds_path.exists():
            raise GoogleSheetsUnavailable(
                f"Service-account key file not found: {creds_path}"
            )
        self._creds = service_account.Credentials.from_service_account_file(
            str(creds_path), scopes=_SCOPES
        )
        self._Request = Request

    def _access_token(self) -> str:
        if not self._creds.valid:
            self._creds.refresh(self._Request())
        return self._creds.token

    def _get(self, url: str, params: dict[str, Any] | None = None) -> dict:
        for attempt in range(3):
            token = self._access_token()
            try:
                r = httpx.get(
                    url,
                    params=params,
                    headers={"Authorization": f"Bearer {token}"},
                    timeout=30.0,
                )
                if r.status_code >= 500:
                    time.sleep(1 + attempt)
                    continue
                r.raise_for_status()
                return r.json()
            except httpx.HTTPError:
                if attempt == 2:
                    raise
                time.sleep(1 + attempt)
        raise RuntimeError("Google Sheets API is unreachable")

    def sheet_metadata(self, spreadsheet_id: str) -> dict:
        return self._get(f"{_SHEETS_API_ROOT}/{spreadsheet_id}")

    def worksheet_name_by_gid(self, spreadsheet_id: str, gid: int) -> str | None:
        meta = self.sheet_metadata(spreadsheet_id)
        for sheet in meta.get("sheets", []):
            props = sheet.get("properties", {})
            if int(props.get("sheetId", -1)) == int(gid):
                return props.get("title")
        return None

    def raw_values(self, spreadsheet_id: str, sheet_range: str) -> list[list[str]]:
        """Range in A1 notation — e.g. `'Sheet1'!A1:Z`."""
        data = self._get(
            f"{_SHEETS_API_ROOT}/{spreadsheet_id}/values/{sheet_range}",
            params={"valueRenderOption": "FORMATTED_VALUE"},
        )
        return data.get("values", [])

    def update_cells(
        self,
        spreadsheet_id: str,
        sheet_range: str,
        values: list[list[str]],
    ) -> dict:
        """
        PUT one contiguous range with cell values (RAW input option, so
        Google Sheets doesn't try to interpret them as formulas).

        `sheet_range` in A1 notation. Values is a 2-D array: one inner
        list per row, cell values as strings.

        Raises `httpx.HTTPError` on 4xx/5xx — callers decide whether to
        swallow (writeback) or propagate.
        """
        from urllib.parse import quote

        token = self._access_token()
        url = f"{_SHEETS_API_ROOT}/{spreadsheet_id}/values/{quote(sheet_range, safe='!:')}"
        r = httpx.put(
            url,
            params={"valueInputOption": "RAW"},
            headers={"Authorization": f"Bearer {token}"},
            json={"values": values},
            timeout=15.0,
        )
        r.raise_for_status()
        return r.json()

    def get_rows(
        self, spreadsheet_id: str, worksheet_name: str
    ) -> list[dict]:
        """
        Read the whole worksheet as a list of dicts (headers → cell).

        - Row 1 = headers (may contain blanks; blank headers keep their
          positional slot via `__cells__`).
        - Empty rows are skipped.
        """
        # Sheet name may contain non-ascii chars → single-quote it.
        safe = worksheet_name.replace("'", "''")
        rows = self.raw_values(spreadsheet_id, f"'{safe}'!A1:ZZ")
        if not rows:
            return []
        headers = [str(h).strip() if h is not None else "" for h in rows[0]]
        out: list[dict] = []
        for idx, row in enumerate(rows[1:], start=2):
            if not row or not any(str(c).strip() for c in row):
                continue
            padded = list(row) + [""] * (len(headers) - len(row))
            entry: dict[str, Any] = {"__row__": idx, "__cells__": padded}
            for h, cell in zip(headers, padded, strict=False):
                if not h:
                    continue
                entry[h] = cell
            out.append(entry)
        return out

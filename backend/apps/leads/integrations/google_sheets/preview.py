"""
Read-only helpers for the «Sheet source wizard» flow.

    fetch_sheet_preview(spreadsheet_id, gid)
        -> {sheet_title, headers, sample_rows, total_rows}

    suggest_column_map(headers)
        -> {phone, full_name, product_hint, has_card, extra_phone}

    suggest_writeback_columns(headers)
        -> {status_col, operator_col, updated_at_col, comment_col}

    parse_spreadsheet_url(url) -> (spreadsheet_id, gid)

Nothing here writes to the database — this module is safe to expose over
an unauthenticated preview endpoint (auth is still enforced at the DRF
view layer; the guarantee is only about DB side effects).

Errors from the Google Sheets API are wrapped in `PreviewError` with a
human message the frontend can show verbatim.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

from django.conf import settings

from .client import GoogleSheetsClient, GoogleSheetsUnavailable


class PreviewError(Exception):
    """Human-readable error for the wizard UI."""


_URL_RE = re.compile(
    r"/spreadsheets/d/(?P<sid>[a-zA-Z0-9_-]+)"
    r"(?:/[^?#]*)?"
    r"(?:[?#].*?gid=(?P<gid>\d+))?"
)


def parse_spreadsheet_url(url: str) -> tuple[str, int]:
    """
    Extract (spreadsheet_id, gid) from a Google Sheets URL.

    gid defaults to 0 if not present (first tab).

    Raises PreviewError on unparseable URL.
    """
    if not url:
        raise PreviewError("URL пустой")
    m = _URL_RE.search(url.strip())
    if not m:
        raise PreviewError(
            "Не удалось разобрать URL. Ожидаю ссылку вида "
            "https://docs.google.com/spreadsheets/d/<id>/edit?gid=<gid>"
        )
    return m.group("sid"), int(m.group("gid") or 0)


def _service_account_email() -> str:
    """
    Read the service-account email from the credentials JSON file so we
    can tell the user exactly whom to share the sheet with when
    Google returns 403.
    """
    path = getattr(settings, "GOOGLE_SHEETS_CREDENTIALS_JSON", "") or ""
    if not path:
        return ""
    try:
        import json

        data = json.loads(Path(path).read_text())
        return str(data.get("client_email") or "")
    except Exception:
        return ""


@dataclass
class SheetPreview:
    sheet_title: str
    headers: list[str]
    sample_rows: list[list[str]]
    total_rows: int


def fetch_sheet_preview(spreadsheet_id: str, gid: int) -> dict:
    """
    Pull the first ~10 data rows via GoogleSheetsClient and return
    headers + sample. Read-only.
    """
    try:
        client = GoogleSheetsClient()
    except GoogleSheetsUnavailable as exc:
        raise PreviewError(f"Google Sheets client недоступен: {exc}") from exc

    try:
        worksheet_name = client.worksheet_name_by_gid(spreadsheet_id, int(gid))
    except Exception as exc:
        raise PreviewError(_humanize_gs_error(exc)) from exc

    if not worksheet_name:
        raise PreviewError(
            f"Лист с gid={gid} не найден в этой таблице. "
            "Проверьте, что вкладка существует и gid правильный."
        )

    safe = worksheet_name.replace("'", "''")
    try:
        rows = client.raw_values(spreadsheet_id, f"'{safe}'!A1:ZZ")
    except Exception as exc:
        raise PreviewError(_humanize_gs_error(exc)) from exc

    if not rows:
        return {
            "sheet_title": worksheet_name,
            "headers": [],
            "sample_rows": [],
            "total_rows": 0,
        }

    headers = [str(h).strip() if h is not None else "" for h in rows[0]]
    data_rows = rows[1:]
    sample = []
    for r in data_rows[:10]:
        padded = list(r) + [""] * (len(headers) - len(r))
        sample.append([str(c) for c in padded[: len(headers)]])
    total = sum(1 for r in data_rows if any(str(c).strip() for c in r))

    return {
        "sheet_title": worksheet_name,
        "headers": headers,
        "sample_rows": sample,
        "total_rows": total,
    }


def _humanize_gs_error(exc: Exception) -> str:
    """Turn google-api HTTP errors into something a manager can act on."""
    msg = str(exc)
    email = _service_account_email() or "сервисный аккаунт"
    lower = msg.lower()
    if "403" in msg or "permission" in lower or "forbidden" in lower:
        return (
            f"Нет доступа к таблице. Откройте её на чтение сервисному "
            f"аккаунту: {email}"
        )
    if "404" in msg or "notfound" in lower or "not found" in lower:
        return "Таблица не найдена (возможно, удалена или неверный id)."
    if "429" in msg or "quota" in lower or "ratelimit" in lower:
        return "Слишком много запросов к Google Sheets. Попробуйте через минуту."
    if "invalid" in lower and "id" in lower:
        return "spreadsheet_id имеет неверный формат."
    return f"Ошибка Google Sheets: {msg}"


# ---- column-map heuristics ------------------------------------------------


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9а-я]+", " ", s.lower()).strip()


# Exact matches — берутся ПЕРЕД keyword-эвристикой чтобы Meta Lead Ads
# заголовки (phone_number / ismingiz_nima?) не путались с product-hint
# колонками содержащими схожие ключевые слова (qanday_telefon_xarid...).
_EXACT_MATCHES = {
    "phone": ["phone_number", "phone", "телефон", "raqam", "phone_num"],
    "full_name": [
        "ismingiz_nima?", "ismingiz nima", "ismingiz",
        "full_name", "имя", "ism", "name", "fio", "фио",
    ],
    "product_hint": [
        "qanday_telefon_xarid_qilmoqchisiz?",
        "qanday_telefon_xarid_qilmoqchisiz",
        "product", "model", "модель", "hint",
    ],
    "has_card": [
        "plastik_kartangiz_bormi?", "plastik_kartangiz_bormi",
        "karta", "card", "карта", "plastik",
    ],
    "extra_phone": [
        "qoshimcha_raqam_qoldirsangiz.", "qoshimcha_raqam_qoldirsangiz",
        "qoshimcha_raqam", "extra_phone",
    ],
}

# Regex keywords — используем ТОЛЬКО если exact-match не нашёл.
# Word-boundary (\b) чтобы "tel" не матчил "telefon" внутри product-hint.
_KEYWORDS = {
    "phone": [
        r"\bphone\b", r"\braqam\b", r"\btel\b", r"телеф", r"номер", r"нoмер",
        r"\bmoby\b", r"\bmobile\b",
    ],
    "full_name": [
        r"\bism\b", r"ismingiz", r"\bname\b", r"\bимя\b", r"\bфио\b",
        r"ф\.и\.о", r"familiya",
    ],
    "product_hint": [
        r"telefon xarid", r"qanday telefon", r"qanday.*telefon",
        r"\bproduct\b", r"модель", r"\bmodel\b", r"\bhint\b",
        r"\btovar\b", r"товар",
    ],
    "has_card": [
        r"\bkarta\b", r"plastik", r"\bcard\b", r"карт", r"credit",
    ],
    "extra_phone": [
        r"qoshimcha", r"qo'shimcha", r"\bextra\b", r"\bsecond\b",
        r"дополнит", r"запасн",
    ],
}


def suggest_column_map(headers: list[str]) -> dict:
    """
    Best-effort mapping of sheet header names to Lead fields.

    Two-phase matching:
      1. **Exact match** — check well-known header names first
         (phone_number, ismingiz_nima?, qanday_telefon_xarid_qilmoqchisiz?)
         so Meta Lead Ads sheets get correct mapping regardless of
         column order.
      2. **Regex keyword** — fallback for other sheet layouts.
         Uses word boundaries to avoid false matches (e.g. "tel" in
         "telefon" belonging to a product-hint column).
    """
    used: set[str] = set()
    result: dict[str, str | None] = {
        "phone": None,
        "full_name": None,
        "product_hint": None,
        "has_card": None,
        "extra_phone": None,
    }
    normalized = [(h, _norm(h)) for h in headers if h]

    # Phase 1: exact-match by known header names.
    # extra_phone must go before phone (both share "raqam" fragment).
    for slot in ["extra_phone", "phone", "full_name", "product_hint", "has_card"]:
        exact_variants = _EXACT_MATCHES.get(slot, [])
        for original, norm in normalized:
            if original in used:
                continue
            # normalize each variant the same way headers are normalized
            for variant in exact_variants:
                if _norm(variant) == norm:
                    result[slot] = original
                    used.add(original)
                    break
            if result[slot]:
                break

    # Phase 2: regex keyword fallback for slots still empty.
    for slot in ["extra_phone", "phone", "full_name", "product_hint", "has_card"]:
        if result[slot]:
            continue
        for original, norm in normalized:
            if original in used:
                continue
            for kw in _KEYWORDS[slot]:
                if re.search(kw, norm):
                    result[slot] = original
                    used.add(original)
                    break
            if result[slot]:
                break

    return result


_WB_KEYWORDS = {
    "status_col": ["crm", "status", "holat", "статус"],
    "operator_col": ["operator", "менедж", "менеж", "manager", "kim", "otvetstv"],
    "updated_at_col": [
        "updated", "sana", "date", "vaqt", "время", "дата", "time", "created",
    ],
    "comment_col": ["comment", "izoh", "note", "коммент", "izox"],
}


def _idx_to_letter(n: int) -> str:
    """1 -> A, 27 -> AA."""
    if n <= 0:
        return "A"
    out = ""
    while n > 0:
        n, r = divmod(n - 1, 26)
        out = chr(65 + r) + out
    return out


def suggest_writeback_columns(headers: list[str]) -> dict:
    """
    Guess writeback column letters (A, B, ... AA) by matching each header
    against writeback slot keywords. Returns None per slot if no header
    matches.
    """
    result: dict[str, str | None] = {
        "status_col": None,
        "operator_col": None,
        "updated_at_col": None,
        "comment_col": None,
    }
    used_idx: set[int] = set()
    normalized = [(i, _norm(h)) for i, h in enumerate(headers, start=1) if h]

    for slot, kws in _WB_KEYWORDS.items():
        for i, norm in normalized:
            if i in used_idx:
                continue
            if any(re.search(kw, norm) for kw in kws):
                result[slot] = _idx_to_letter(i)
                used_idx.add(i)
                break

    return result

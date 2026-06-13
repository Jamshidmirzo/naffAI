"""
Excel export for sales.

The output mimics the shop's own «savdo» / «nomerla» workbook so a
manager can download what they uploaded, with the same column layout
and split-line semantics ('Alif+Birzum' in Hamkorlar / '5300000+6900000'
in amount when a sale was paid via several partners).

Filters (`search`, `operator`, `channel`, `date_from`, `date_to`) reuse
`sale_list` so the exported workbook contains exactly the rows the
manager sees in the UI list.
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Iterable
from decimal import Decimal

from django.utils import timezone
from django.utils.dateparse import parse_datetime
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter
from rest_framework.views import APIView

from apps.common.excel import (
    HEADER_FILL,
    HEADER_FONT,
    MONEY_FMT,
    new_workbook,
    workbook_response,
)
from apps.operators.models import Operator, OperatorStatus
from apps.users.permissions import IsTeamLeadOrManagerReadOnly

from .models import Sale
from .selectors import sale_list

# Column layout for the `savdo` sheet, matching the source workbook.
SAVDO_HEADERS: list[str | None] = [
    "model",     # A
    "ime",       # B
    "mijoz",     # C
    "mijoz nomer",  # D
    "Hamkorlar",   # E
    None,          # F (amount column — header in original was empty/merged)
    "ishchila",  # G
    "Daplata",   # H
    None, None, None, None, None, None, None,  # I-O spare
    "Rasxodlar",  # P
    "izoh",       # Q
]

SAVDO_DATE_FMT = "MM.DD.YY"
DATE_MARKER_FILL = PatternFill("solid", fgColor="FEF3C7")
DATE_MARKER_FONT = Font(bold=True)


def _split_comment(comment: str) -> dict:
    """
    Pull the prefixed parts back out of comments the importer/UI stored
    in the shape «клиент: X | тел: Y | предоплата: Z | расход: W | rest».
    Anything that doesn't match a prefix is concatenated into `rest`.
    """
    out = {"client": "", "phone": "", "downpayment": "", "expense": "", "rest": []}
    for part in (comment or "").split(" | "):
        s = part.strip()
        if not s:
            continue
        for key, prefix in (
            ("client", "клиент: "),
            ("phone", "тел: "),
            ("downpayment", "предоплата: "),
            ("expense", "расход: "),
        ):
            if s.startswith(prefix):
                out[key] = s[len(prefix):].strip()
                break
        else:
            out["rest"].append(s)
    out["rest"] = " | ".join(out["rest"])
    return out


def _joined_partner_names(sale: Sale) -> str:
    lines = list(sale.partner_lines.select_related("partner").all())
    if lines:
        return "+".join(line.partner.name for line in lines)
    return sale.channel.name if sale.channel_id else ""


def _joined_partner_amounts(sale: Sale):
    lines = list(sale.partner_lines.all())
    if len(lines) > 1:
        # Excel can't store mixed types in a number cell, so multi-amount
        # rows become strings — same convention as the source workbook.
        return "+".join(str(int(line.amount)) for line in lines)
    if lines:
        return float(lines[0].amount)
    return float(sale.amount)


def _joined_operator_names(sale: Sale) -> str:
    lines = list(sale.operator_lines.select_related("operator").all())
    if lines:
        return "+".join(line.operator.full_name for line in lines)
    return sale.operator.full_name if sale.operator_id else ""


def _sale_to_savdo_row(sale: Sale) -> list:
    parsed = _split_comment(sale.comment or "")
    row: list = [None] * len(SAVDO_HEADERS)
    row[0] = sale.phone_model or ""
    row[1] = int(sale.imei) if sale.imei.isdigit() else sale.imei
    row[2] = parsed["client"]
    row[3] = parsed["phone"]
    row[4] = _joined_partner_names(sale)
    row[5] = _joined_partner_amounts(sale)
    row[6] = _joined_operator_names(sale)
    row[7] = parsed["downpayment"]
    row[15] = parsed["expense"]
    row[16] = parsed["rest"]
    return row


def _write_savdo_sheet(wb, sales: Iterable[Sale]) -> None:
    ws = wb.create_sheet("savdo")
    ws.append([h or "" for h in SAVDO_HEADERS])
    for cell in ws[1]:
        if cell.value:
            cell.font = HEADER_FONT
            cell.fill = HEADER_FILL
            cell.alignment = Alignment(horizontal="center", vertical="center")

    tz = timezone.get_current_timezone()
    by_date: dict = defaultdict(list)
    for s in sales:
        # Group by the LOCAL date the shop sees, not the UTC date — otherwise
        # a midnight-local sale lands one day earlier in the export header.
        by_date[s.sold_at.astimezone(tz).date()].append(s)

    total = Decimal("0")
    for d in sorted(by_date.keys()):
        marker_row = [None] * len(SAVDO_HEADERS)
        marker_row[0] = d
        ws.append(marker_row)
        last = ws.max_row
        cell = ws.cell(row=last, column=1)
        cell.fill = DATE_MARKER_FILL
        cell.font = DATE_MARKER_FONT
        cell.number_format = SAVDO_DATE_FMT

        for sale in by_date[d]:
            ws.append(_sale_to_savdo_row(sale))
            if not sale.is_returned:
                total += sale.amount

    ws.append([None] * len(SAVDO_HEADERS))
    totals_row = ws.max_row + 1
    ws.cell(row=totals_row, column=5, value="ИТОГО")
    ws.cell(row=totals_row, column=6, value=float(total))
    for col in (5, 6):
        c = ws.cell(row=totals_row, column=col)
        c.font = Font(bold=True)
        c.fill = PatternFill("solid", fgColor="F3F4F6")

    for col_idx in range(1, len(SAVDO_HEADERS) + 1):
        letter = get_column_letter(col_idx)
        max_len = len(str(SAVDO_HEADERS[col_idx - 1] or ""))
        for cell in ws[letter]:
            v = "" if cell.value is None else str(cell.value)
            if len(v) > max_len:
                max_len = len(v)
        ws.column_dimensions[letter].width = min(max_len + 2, 50)

    for c in ws.iter_cols(min_col=6, max_col=6, min_row=2):
        for cell in c:
            if isinstance(cell.value, int | float):
                cell.number_format = MONEY_FMT

    ws.freeze_panes = "A2"


def _write_nomerla_sheet(wb) -> None:
    ws = wb.create_sheet("nomerla")
    ws.append(["Isim", "shaxsiy", "kampaniya"])
    for cell in ws[1]:
        cell.font = HEADER_FONT
        cell.fill = HEADER_FILL
        cell.alignment = Alignment(horizontal="center")
    for op in (
        Operator.objects.exclude(status=OperatorStatus.INACTIVE).order_by("full_name")
    ):
        ws.append([op.full_name, op.phone or None, None])
    for col in (1, 2, 3):
        ws.column_dimensions[get_column_letter(col)].width = 24
    ws.freeze_panes = "A2"


class SaleExportApi(APIView):
    permission_classes = [IsTeamLeadOrManagerReadOnly]

    def get(self, request):
        params = request.query_params
        qs = (
            sale_list(
                search=params.get("search"),
                operator_id=params.get("operator") or None,
                channel_id=params.get("channel") or None,
                date_from=parse_datetime(params.get("date_from"))
                if params.get("date_from")
                else None,
                date_to=parse_datetime(params.get("date_to"))
                if params.get("date_to")
                else None,
            )
            .prefetch_related("operator_lines__operator", "partner_lines__partner")
            .order_by("sold_at", "id")
        )

        wb = new_workbook()
        _write_savdo_sheet(wb, qs.iterator(chunk_size=500))
        _write_nomerla_sheet(wb)
        return workbook_response(wb, "naffcrm-savdo.xlsx")

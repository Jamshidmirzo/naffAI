"""
Phone-level dedup on sheet import (2026-08-30).

`lead_create_from_sheet_row` used to be idempotent only by
(sheet_source, row_index). If the same customer showed up in a different
sheet row (fresh copy-paste, second channel, resurrected old export) —
we'd create a second Lead with the same phone and the CRM would show
two cards for one person.

The new behaviour:
  - non-terminal Lead with same normalized phone → REUSE (return
    ("merged")), soft-update name/product/card/alt-phone if the new row
    is richer, append `duplicate_sheet_rows` audit trail.
  - only-terminal Leads with same phone → still CREATE a fresh Lead
    (client came back after a closed history).
  - empty / invalid phone → still CREATE (nothing to dedup on).
  - status and operator on the winner lead are NEVER modified by merge.
"""

from __future__ import annotations

import pytest

from apps.leads.models import Lead, LeadStatus, SheetSource
from apps.leads.services import lead_create_from_sheet_row

SPREADSHEET_ID = "TEST_DEDUP"


@pytest.fixture
def sheet_a(db) -> SheetSource:
    return SheetSource.objects.create(
        name="Sheet A",
        spreadsheet_id=SPREADSHEET_ID,
        gid=1,
        column_map={
            "full_name": "full_name",
            "phone": "phone_number",
            "product_hint": "product",
            "has_card": "card",
        },
        default_status=LeadStatus.NEW,
    )


@pytest.fixture
def sheet_b(db) -> SheetSource:
    return SheetSource.objects.create(
        name="Sheet B",
        spreadsheet_id=SPREADSHEET_ID,
        gid=2,
        column_map={
            "full_name": "full_name",
            "phone": "phone_number",
            "product_hint": "product",
            "has_card": "card",
        },
        default_status=LeadStatus.NEW,
    )


def _row(row_index: int, *, phone: str, name: str = "", product: str = "", card: str = "") -> dict:
    return {
        "__row__": row_index,
        "__cells__": [],
        "full_name": name,
        "phone_number": phone,
        "product": product,
        "card": card,
    }


# ---- happy dedup path ---------------------------------------------------


@pytest.mark.django_db
def test_active_existing_phone_merges_instead_of_creating(sheet_a, sheet_b):
    """
    Same phone, different sheet: we return the ORIGINAL lead, keep
    Lead.count() at 1, and drop an audit trail into
    `metadata["duplicate_sheet_rows"]`.
    """
    first, outcome_first = lead_create_from_sheet_row(
        sheet_source=sheet_a,
        row_index=10,
        raw_row=_row(10, phone="998901112233", name="Vasya"),
    )
    assert outcome_first == "created"

    second, outcome_second = lead_create_from_sheet_row(
        sheet_source=sheet_b,
        row_index=42,
        raw_row=_row(42, phone="998901112233", name="Vasya"),
    )
    assert outcome_second == "merged"
    assert second.id == first.id
    assert Lead.objects.filter(phone="+998901112233").count() == 1

    second.refresh_from_db()
    trail = second.metadata.get("duplicate_sheet_rows") or []
    assert len(trail) == 1
    assert trail[0]["sheet_source_id"] == sheet_b.id
    assert trail[0]["sheet_row_index"] == 42
    # Winner's own sheet_source / sheet_row_index MUST stay on the original
    # row so per-lead writeback keeps updating the right cell.
    assert second.sheet_source_id == sheet_a.id
    assert second.sheet_row_index == 10


@pytest.mark.django_db
def test_terminal_only_phone_creates_new_lead(sheet_a, sheet_b):
    """
    Phone belongs ONLY to closed leads (won / lost / archived / …). The
    client is coming back after a closed history — deserve a fresh
    working card. `Lead.count()` grows.
    """
    lost, _ = lead_create_from_sheet_row(
        sheet_source=sheet_a,
        row_index=1,
        raw_row=_row(1, phone="998901112277", name="Old"),
    )
    lost.status = LeadStatus.LOST
    lost.save(update_fields=["status", "updated_at"])

    fresh, outcome = lead_create_from_sheet_row(
        sheet_source=sheet_b,
        row_index=2,
        raw_row=_row(2, phone="998901112277", name="Old Return"),
    )
    assert outcome == "created"
    assert fresh.id != lost.id
    assert Lead.objects.filter(phone="+998901112277").count() == 2


@pytest.mark.django_db
def test_invalid_phone_bypasses_dedup(sheet_a):
    """
    Unparseable phone → we have no key to dedup on, so we always create.
    Second row with the same broken phone-raw string still creates a
    second lead (this is the historical behaviour — unchanged).
    """
    a, _ = lead_create_from_sheet_row(
        sheet_source=sheet_a,
        row_index=1,
        raw_row=_row(1, phone="broken-phone", name="A"),
    )
    b, outcome = lead_create_from_sheet_row(
        sheet_source=sheet_a,
        row_index=2,
        raw_row=_row(2, phone="broken-phone", name="B"),
    )
    assert outcome == "created"
    assert a.id != b.id
    assert a.phone == ""
    assert b.phone == ""


# ---- soft-field merge semantics -----------------------------------------


@pytest.mark.django_db
def test_soft_fields_pulled_in_when_richer(sheet_a, sheet_b):
    """
    Existing lead has empty product / card; the new sheet row fills them
    in. Merge should propagate the non-empty values.
    """
    first, _ = lead_create_from_sheet_row(
        sheet_source=sheet_a,
        row_index=1,
        raw_row=_row(1, phone="998901112211", name="", product="", card=""),
    )
    assert first.product_hint == ""
    assert first.has_card == ""

    merged, outcome = lead_create_from_sheet_row(
        sheet_source=sheet_b,
        row_index=1,
        raw_row=_row(
            1, phone="998901112211", name="Petya", product="iPhone 15", card="Ha"
        ),
    )
    assert outcome == "merged"
    merged.refresh_from_db()
    assert merged.full_name == "Petya"
    assert merged.product_hint == "iPhone 15"
    assert merged.has_card == "Ha"


@pytest.mark.django_db
def test_empty_new_values_do_not_overwrite(sheet_a, sheet_b):
    """
    Existing lead has name/product/card. New sheet row has BLANK values
    (empty strings). We must NOT clobber the existing data with blanks.
    """
    first, _ = lead_create_from_sheet_row(
        sheet_source=sheet_a,
        row_index=1,
        raw_row=_row(
            1, phone="998901112212", name="Alice", product="iPhone 14", card="Ha"
        ),
    )

    merged, outcome = lead_create_from_sheet_row(
        sheet_source=sheet_b,
        row_index=2,
        raw_row=_row(2, phone="998901112212", name="", product="", card=""),
    )
    assert outcome == "merged"
    merged.refresh_from_db()
    assert merged.full_name == "Alice"
    assert merged.product_hint == "iPhone 14"
    assert merged.has_card == "Ha"


# ---- status / operator must be immutable on merge -----------------------


@pytest.mark.django_db
def test_merge_does_not_touch_status_or_operator(sheet_a, sheet_b):
    """
    The operator's status choice on the winner lead is sacred. New sheet
    rows can add history entries, but they must not roll back an
    operator's IN_PROGRESS to NEW or reassign the operator.
    """
    from apps.operators.models import Operator, OperatorStatus

    op = Operator.objects.create(full_name="Op1", status=OperatorStatus.ACTIVE)
    existing, _ = lead_create_from_sheet_row(
        sheet_source=sheet_a,
        row_index=5,
        raw_row=_row(5, phone="998901112213", name="Ivan"),
    )
    existing.status = LeadStatus.IN_PROGRESS
    existing.operator = op
    existing.save(update_fields=["status", "operator", "updated_at"])

    merged, outcome = lead_create_from_sheet_row(
        sheet_source=sheet_b,
        row_index=99,
        raw_row=_row(99, phone="998901112213", name="Ivan Ivanov"),
    )
    assert outcome == "merged"
    merged.refresh_from_db()
    assert merged.status == LeadStatus.IN_PROGRESS
    assert merged.operator_id == op.id
    assert merged.full_name == "Ivan Ivanov"  # soft-field DID update


@pytest.mark.django_db
def test_multiple_merges_accumulate_trail(sheet_a, sheet_b):
    """
    3 incoming rows with the same phone → 1 lead + 2 trail entries
    (the first row created, the next two merged).
    """
    first, o1 = lead_create_from_sheet_row(
        sheet_source=sheet_a,
        row_index=1,
        raw_row=_row(1, phone="998901112214", name="X"),
    )
    _, o2 = lead_create_from_sheet_row(
        sheet_source=sheet_b,
        row_index=2,
        raw_row=_row(2, phone="998901112214", name="X"),
    )
    _, o3 = lead_create_from_sheet_row(
        sheet_source=sheet_b,
        row_index=3,
        raw_row=_row(3, phone="998901112214", name="X"),
    )
    assert (o1, o2, o3) == ("created", "merged", "merged")
    assert Lead.objects.filter(phone="+998901112214").count() == 1

    first.refresh_from_db()
    trail = first.metadata.get("duplicate_sheet_rows") or []
    assert len(trail) == 2
    assert {t["sheet_row_index"] for t in trail} == {2, 3}


@pytest.mark.django_db
def test_row_index_resync_still_uses_resynced_outcome(sheet_a):
    """
    Regression guard: hitting the same (sheet_source, row_index) twice
    stays on the `resynced` path (not `merged`) — this is the historical
    idempotency contract and it takes precedence over the phone dedup.
    """
    a, o1 = lead_create_from_sheet_row(
        sheet_source=sheet_a,
        row_index=7,
        raw_row=_row(7, phone="998901112215", name="Y"),
    )
    b, o2 = lead_create_from_sheet_row(
        sheet_source=sheet_a,
        row_index=7,
        raw_row=_row(7, phone="998901112215", name="Y"),
    )
    assert (o1, o2) == ("created", "resynced")
    assert a.id == b.id

"""
`lead_create_from_sheet_row` is the workhorse of Google Sheets sync.
These tests exercise its contract without touching Google's servers:

  - idempotency by (sheet_source, row_index)
  - phone normalisation → +998XXXXXXXXX
  - alias resolution (bound / unbound / unknown)
  - archived-status default (Bitrix Sheet 3) shortcut
  - metadata extraction from `column_map["extra"]`
"""

from __future__ import annotations

import pytest

from apps.leads.models import (
    Lead,
    LeadStatus,
    OperatorSheetAlias,
    SheetSource,
)
from apps.leads.services import lead_create_from_sheet_row
from apps.operators.models import Operator, OperatorStatus

SPREADSHEET_ID = "TEST_SS"


@pytest.fixture
def sheet_1(db) -> SheetSource:
    return SheetSource.objects.create(
        name="Sheet 1",
        spreadsheet_id=SPREADSHEET_ID,
        gid=1,
        column_map={
            "full_name": "full_name",
            "phone": "phone_number",
            "product_hint": "qanday_telefon?",
            "has_card": "plastik?",
            "operator_alias": {"column_index": 5},
        },
        default_status=LeadStatus.NEW,
    )


@pytest.fixture
def sheet_bitrix(db) -> SheetSource:
    return SheetSource.objects.create(
        name="Sheet 3 archive",
        spreadsheet_id=SPREADSHEET_ID,
        gid=3,
        column_map={
            "full_name": "ismingiz:",
            "phone": "telefon_raqamingiz",
            "extra": ["STATUS", "IZOH", "bitrix_deal_id"],
        },
        default_status=LeadStatus.ARCHIVED,
    )


@pytest.fixture
def op_alice(db):
    return Operator.objects.create(full_name="Alice", status=OperatorStatus.ACTIVE)


@pytest.mark.django_db
def test_sync_is_idempotent_by_row_index(sheet_1, op_alice):
    OperatorSheetAlias.objects.create(alias_name="Alice", operator=op_alice)

    row = {
        "__row__": 5,
        "__cells__": ["Ha", "iPhone 14", "Vasya", "998901112233", "Alice"],
        "full_name": "Vasya",
        "phone_number": "998901112233",
        "qanday_telefon?": "iPhone 14",
        "plastik?": "Ha",
    }
    lead1 = lead_create_from_sheet_row(sheet_source=sheet_1, row_index=5, raw_row=row)
    lead2 = lead_create_from_sheet_row(sheet_source=sheet_1, row_index=5, raw_row=row)
    assert lead1.id == lead2.id
    assert Lead.objects.filter(sheet_source=sheet_1, sheet_row_index=5).count() == 1


@pytest.mark.django_db
def test_sync_normalizes_phone(sheet_1, op_alice):
    OperatorSheetAlias.objects.create(alias_name="Alice", operator=op_alice)
    row = {
        "__row__": 2,
        "__cells__": ["Ha", "iPhone 14", "Ivan", "998-90-111-22-33", "Alice"],
        "full_name": "Ivan",
        "phone_number": "998-90-111-22-33",
    }
    lead = lead_create_from_sheet_row(sheet_source=sheet_1, row_index=2, raw_row=row)
    assert lead.phone == "+998901112233"
    assert lead.phone_invalid is False


@pytest.mark.django_db
def test_sync_flags_bad_phone_as_needs_review(sheet_1, op_alice):
    OperatorSheetAlias.objects.create(alias_name="Alice", operator=op_alice)
    row = {
        "__row__": 2,
        "__cells__": ["Ha", "iPhone 14", "Broken", "not-a-phone", "Alice"],
        "full_name": "Broken",
        "phone_number": "not-a-phone",
    }
    lead = lead_create_from_sheet_row(sheet_source=sheet_1, row_index=2, raw_row=row)
    assert lead.phone_invalid is True
    assert lead.needs_review is True
    assert lead.status == LeadStatus.NEEDS_REVIEW


@pytest.mark.django_db
def test_sync_bound_alias_assigns_immediately(sheet_1, op_alice):
    OperatorSheetAlias.objects.create(alias_name="Alice", operator=op_alice)
    row = {
        "__row__": 2,
        "__cells__": ["Ha", "iPhone 14", "V", "998901112233", "Alice"],
        "full_name": "V",
        "phone_number": "998901112233",
    }
    lead = lead_create_from_sheet_row(sheet_source=sheet_1, row_index=2, raw_row=row)
    assert lead.operator_id == op_alice.id
    assert lead.status == LeadStatus.ASSIGNED
    assert lead.needs_review is False


@pytest.mark.django_db
def test_sync_unbound_alias_marks_needs_review(sheet_1, op_alice):
    OperatorSheetAlias.objects.create(alias_name="Bob", operator=None)
    row = {
        "__row__": 3,
        "__cells__": ["Ha", "iPhone 14", "V", "998901112233", "Bob"],
        "full_name": "V",
        "phone_number": "998901112233",
    }
    lead = lead_create_from_sheet_row(sheet_source=sheet_1, row_index=3, raw_row=row)
    assert lead.needs_review is True
    assert lead.operator_id is None
    assert lead.status == LeadStatus.NEEDS_REVIEW


@pytest.mark.django_db
def test_sync_unknown_alias_persists_placeholder(sheet_1):
    row = {
        "__row__": 4,
        "__cells__": ["Ha", "iPhone", "V", "998901112233", "NewFace"],
        "full_name": "V",
        "phone_number": "998901112233",
    }
    lead = lead_create_from_sheet_row(sheet_source=sheet_1, row_index=4, raw_row=row)
    assert lead.needs_review is True
    assert OperatorSheetAlias.objects.filter(alias_name="NewFace", operator=None).exists()


@pytest.mark.django_db
def test_sync_bitrix_archive_ignores_auto_assign_and_stores_metadata(sheet_bitrix, op_alice):
    row = {
        "__row__": 2,
        "__cells__": [],
        "ismingiz:": "Old",
        "telefon_raqamingiz": "998901112233",
        "STATUS": "SOLD",
        "IZOH": "Bought elsewhere",
        "bitrix_deal_id": "12345",
    }
    lead = lead_create_from_sheet_row(sheet_source=sheet_bitrix, row_index=2, raw_row=row)
    assert lead.status == LeadStatus.ARCHIVED
    assert lead.needs_review is False
    assert lead.operator_id is None
    assert lead.metadata["STATUS"] == "SOLD"
    assert lead.metadata["bitrix_deal_id"] == "12345"

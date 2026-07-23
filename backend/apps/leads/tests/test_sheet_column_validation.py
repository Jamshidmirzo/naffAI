import pytest
from unittest.mock import MagicMock
from apps.common.exceptions import ApplicationError
from apps.leads.integrations.google_sheets.sync import sync_one
from apps.leads.models import SheetSource


@pytest.mark.django_db
def test_sync_fails_when_column_map_incomplete():
    source = SheetSource.objects.create(
        name="Test Sheet",
        spreadsheet_id="sheet123",
        gid=0,
        worksheet_name="Sheet1",
        column_map={"full_name": "Full Name"},  # missing phone
    )
    client = MagicMock()
    client.get_rows.return_value = [{"Full Name": "John"}]

    with pytest.raises(ApplicationError, match="missing column mapping for"):
        sync_one(client=client, sheet_source=source)

    source.refresh_from_db()
    assert "missing column mapping" in source.last_sync_error


@pytest.mark.django_db
def test_sync_fails_when_required_column_renamed():
    source = SheetSource.objects.create(
        name="Test Sheet",
        spreadsheet_id="sheet123",
        gid=0,
        worksheet_name="Sheet1",
        column_map={"full_name": "Full Name", "phone": "Phone Number"},
    )
    client = MagicMock()
    client.get_rows.return_value = [{"Full Name": "John", "Wrong Header": "+998901234567"}]

    with pytest.raises(ApplicationError, match="not found in sheet headers"):
        sync_one(client=client, sheet_source=source)

    source.refresh_from_db()
    assert "not found in sheet headers" in source.last_sync_error

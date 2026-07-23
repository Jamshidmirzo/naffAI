import pytest
from unittest.mock import MagicMock
from apps.leads.integrations.google_sheets.sync import sync_one
from apps.leads.models import SheetSource


@pytest.mark.django_db
def test_sync_parallel_locking_select_for_update():
    source = SheetSource.objects.create(
        name="Locked Sheet",
        spreadsheet_id="sheet_lock_123",
        gid=0,
        worksheet_name="Sheet1",
        column_map={"full_name": "Full Name", "phone": "Phone"},
    )
    client = MagicMock()
    client.get_rows.return_value = [{"__row__": 1, "Full Name": "Test", "Phone": "+998901112233"}]

    res = sync_one(client=client, sheet_source=source)
    assert res.read == 1
    source.refresh_from_db()
    assert source.last_synced_row >= 1

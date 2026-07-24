import pytest
from django.test import override_settings
from apps.catalog.imei_service import imei_lookup
from apps.catalog.models import TacLookup

pytestmark = pytest.mark.django_db

@override_settings(IMEI_ONLINE_LOOKUP_ENABLED=False)
def test_imei_lookup_local_hit(db):
    TacLookup.objects.create(tac="49015420", brand="Apple", model="iPhone 13")
    result = imei_lookup("490154203237518")
    assert result.valid is True
    assert result.brand == "Apple"
    assert result.model == "iPhone 13"
    assert result.source == "local"

@override_settings(IMEI_ONLINE_LOOKUP_ENABLED=False)
def test_imei_lookup_local_miss(db):
    result = imei_lookup("490154203237518")
    assert result.valid is True
    assert result.source == "none"

@override_settings(IMEI_ONLINE_LOOKUP_ENABLED=False)
def test_imei_lookup_invalid_short(db):
    result = imei_lookup("12345")
    assert result.valid is False

@override_settings(IMEI_ONLINE_LOOKUP_ENABLED=False)
def test_imei_lookup_invalid_letters(db):
    result = imei_lookup("abc154203237518")
    assert result.valid is False

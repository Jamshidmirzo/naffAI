import pytest
from apps.common.exceptions import ApplicationError
from apps.catalog.services import channel_create
from apps.catalog.models import Channel
from apps.audit.models import AuditLog
from apps.audit.services import AuditAction

pytestmark = pytest.mark.django_db

def test_channel_create_happy_path(db):
    channel = channel_create(name="Telegram")
    assert channel.name == "Telegram"
    assert channel.is_active is True
    
    log = AuditLog.objects.filter(entity="catalog.Channel", entity_id=channel.id).first()
    assert log is not None

def test_channel_create_duplicate_active_raises(db):
    channel_create(name="Telegram")
    with pytest.raises(ApplicationError) as exc:
        channel_create(name="Telegram")
    assert "уже существует" in str(exc.value)

def test_channel_create_reactivation(db):
    channel = channel_create(name="Telegram")
    channel.is_active = False
    channel.save()
    
    reactivated = channel_create(name="Telegram")
    assert reactivated.id == channel.id
    assert reactivated.is_active is True

    log = (
        AuditLog.objects.filter(entity="catalog.Channel", entity_id=channel.id)
        .order_by("-created_at")
        .first()
    )
    assert log is not None
    assert "reactivated via create" in log.comment

def test_channel_create_empty_name_raises(db):
    with pytest.raises(ApplicationError) as exc:
        channel_create(name="   ")
    assert "Название не может быть пустым" in str(exc.value)

def test_channel_create_case_insensitive(db):
    channel_create(name="Alif")
    with pytest.raises(ApplicationError) as exc:
        channel_create(name="alif")
    assert "уже существует" in str(exc.value)

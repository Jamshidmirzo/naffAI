import pytest

from apps.tg_bot.runner import _bot_complete_callback, _bot_snooze_callback


@pytest.mark.django_db
def test_bot_complete_returns_false_for_invalid_reminder_id():
    ok = _bot_complete_callback(99999)
    assert ok is False


@pytest.mark.django_db
def test_bot_snooze_returns_false_for_invalid_reminder_id():
    ok = _bot_snooze_callback(99999, 15)
    assert ok is False

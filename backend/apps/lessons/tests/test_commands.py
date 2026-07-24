import datetime as dt
from decimal import Decimal
from unittest.mock import AsyncMock, patch
import pytest
from django.core.management import call_command
from django.utils import timezone
from django.test import override_settings

from apps.operators.models import Operator
from apps.lessons.models import DailyLesson, DailyLessonAttempt
from apps.users.models import Profile, Role


@pytest.fixture
def operator(db):
    return Operator.objects.create(full_name="Тестовый Оператор", status="active")


@pytest.fixture
def fake_llm():
    fake_json = """
    {
      "summary": "День прошел хорошо.",
      "highlights": [],
      "tips": [],
      "micro_lesson": "Улыбайтесь!"
    }
    """
    from apps.tg_userclient.ai.provider import LLMResponse

    class FakeProvider:
        def generate_content(self, *, prompt, response_json=False):
            return LLMResponse(text=fake_json, model_used="test-model", provider="none")

    with patch("apps.lessons.ai.generator.get_llm_provider", return_value=FakeProvider()):
        yield


@pytest.mark.django_db
def test_command_skip_empty_day(operator):
    today = timezone.localdate()
    yesterday = today - dt.timedelta(days=1)

    call_command("generate_daily_lessons", date=yesterday.strftime("%Y-%m-%d"))

    assert DailyLesson.objects.count() == 0
    assert DailyLessonAttempt.objects.count() == 1
    attempt = DailyLessonAttempt.objects.first()
    assert attempt.status == "skip"


@pytest.mark.django_db
def test_command_idempotent(operator, fake_llm):
    today = timezone.localdate()
    yesterday = today - dt.timedelta(days=1)

    # Force collect_yesterday_facts to think there's activity
    fake_facts = {
        "sales": {"count": 1, "revenue": 1000, "avg_check": 1000, "brand_mix": {}, "delta_revenue": 0, "delta_count": 0},
        "dialogs": {"count": 1, "avg_quality_score": 80, "top_3_red_flags": [], "top_3_highlights": []},
        "callbacks": {"missed": 0, "on_time": 0, "avg_delay_min": 0},
        "leads": {"won": 0, "lost": 0, "stalled": 0},
        "context": {"month_progress_pct": 0, "days_to_threshold": 10, "personal_baseline_30d": 0},
        "chat_examples": [],
    }

    with patch("apps.lessons.management.commands.generate_daily_lessons.collect_yesterday_facts", return_value=fake_facts):
        # First call
        call_command("generate_daily_lessons", date=yesterday.strftime("%Y-%m-%d"))
        # Second call
        call_command("generate_daily_lessons", date=yesterday.strftime("%Y-%m-%d"))

    assert DailyLesson.objects.count() == 1
    assert DailyLessonAttempt.objects.filter(status="ok").count() == 1


@pytest.mark.django_db
@override_settings(TELEGRAM_BOT_TOKEN="fake-token")
def test_delivery_sets_delivered_at(operator):
    from django.contrib.auth import get_user_model
    User = get_user_model()
    user = User.objects.create_user(username="testuser", password="x")
    Profile.objects.create(user=user, role=Role.OPERATOR, operator=operator, telegram_user_id=98765)

    today = timezone.localdate()
    yesterday = today - dt.timedelta(days=1)

    # Create DailyLesson
    lesson = DailyLesson.objects.create(
        operator=operator,
        lesson_date=yesterday,
        summary="Отлично",
        micro_lesson="Фокус на продажи",
        model_version="test",
        prompt_version="v1",
        stats_snapshot={},
    )

    mock_bot = AsyncMock()
    with patch("aiogram.Bot", return_value=mock_bot):
        call_command("deliver_daily_lessons", date=yesterday.strftime("%Y-%m-%d"))

    lesson.refresh_from_db()
    assert lesson.delivered_at is not None
    mock_bot.send_message.assert_called_once()


@pytest.mark.django_db
@override_settings(TELEGRAM_BOT_TOKEN="fake-token")
def test_delivery_skip_greeting(operator):
    from django.contrib.auth import get_user_model
    User = get_user_model()
    user = User.objects.create_user(username="testuser", password="x")
    Profile.objects.create(user=user, role=Role.OPERATOR, operator=operator, telegram_user_id=98765)

    today = timezone.localdate()
    yesterday = today - dt.timedelta(days=1)

    # Create skipped attempt
    attempt = DailyLessonAttempt.objects.create(
        operator=operator,
        lesson_date=yesterday,
        status="skip",
    )

    mock_bot = AsyncMock()
    with patch("aiogram.Bot", return_value=mock_bot):
        call_command("deliver_daily_lessons", date=yesterday.strftime("%Y-%m-%d"))

    attempt.refresh_from_db()
    assert attempt.delivered_at is not None
    mock_bot.send_message.assert_called_once()


def _make_transient_error():
    """
    Build a `TelegramNetworkError` that's cheap to raise from a mock.
    Signature differs slightly across aiogram versions — we try the
    modern (method, message) constructor and fall back to a string-only
    ctor if that fails.
    """
    from aiogram.exceptions import TelegramNetworkError

    try:
        return TelegramNetworkError(method=None, message="simulated network flake")
    except TypeError:
        return TelegramNetworkError("simulated network flake")


@pytest.mark.django_db
@override_settings(TELEGRAM_BOT_TOKEN="fake-token")
def test_delivery_retries_on_tg_error(operator):
    """
    Delivery should retry up to 3 times on transient TG errors.
    First two attempts fail, third succeeds → delivered_at is set and
    send_message was called exactly 3 times.
    """
    from django.contrib.auth import get_user_model
    User = get_user_model()
    user = User.objects.create_user(username="testuser", password="x")
    Profile.objects.create(user=user, role=Role.OPERATOR, operator=operator, telegram_user_id=98765)

    today = timezone.localdate()
    yesterday = today - dt.timedelta(days=1)

    lesson = DailyLesson.objects.create(
        operator=operator,
        lesson_date=yesterday,
        summary="Отлично",
        micro_lesson="Фокус на продажи",
        model_version="test",
        prompt_version="v1",
        stats_snapshot={},
    )

    err = _make_transient_error()
    mock_bot = AsyncMock()
    # 2 transient errors, then success. `side_effect` with a list makes
    # AsyncMock raise/return per-call in order.
    mock_bot.send_message.side_effect = [err, err, None]

    async def _no_sleep(_):
        return None

    with patch("aiogram.Bot", return_value=mock_bot), \
         patch("apps.lessons.management.commands.deliver_daily_lessons.asyncio.sleep", _no_sleep):
        call_command("deliver_daily_lessons", date=yesterday.strftime("%Y-%m-%d"))

    lesson.refresh_from_db()
    assert lesson.delivered_at is not None
    assert mock_bot.send_message.await_count == 3


@pytest.mark.django_db
@override_settings(TELEGRAM_BOT_TOKEN="fake-token")
def test_delivery_gives_up_after_three_failed_attempts(operator):
    """
    If every retry fails, delivered_at stays NULL so the next timer
    tick picks the lesson up again. Exactly 3 attempts are made.
    """
    from django.contrib.auth import get_user_model
    User = get_user_model()
    user = User.objects.create_user(username="testuser", password="x")
    Profile.objects.create(user=user, role=Role.OPERATOR, operator=operator, telegram_user_id=98765)

    today = timezone.localdate()
    yesterday = today - dt.timedelta(days=1)

    lesson = DailyLesson.objects.create(
        operator=operator,
        lesson_date=yesterday,
        summary="Отлично",
        micro_lesson="Фокус на продажи",
        model_version="test",
        prompt_version="v1",
        stats_snapshot={},
    )

    err = _make_transient_error()
    mock_bot = AsyncMock()
    mock_bot.send_message.side_effect = [err, err, err]

    async def _no_sleep(_):
        return None

    with patch("aiogram.Bot", return_value=mock_bot), \
         patch("apps.lessons.management.commands.deliver_daily_lessons.asyncio.sleep", _no_sleep):
        call_command("deliver_daily_lessons", date=yesterday.strftime("%Y-%m-%d"))

    lesson.refresh_from_db()
    assert lesson.delivered_at is None
    assert mock_bot.send_message.await_count == 3

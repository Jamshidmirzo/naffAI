"""
F2 — Morning greetings service tests.

Covers:
- One quote per (day, language) — second call returns cached row.
- Different language → different row.
- LLM failure → static fallback returned but not persisted.
- Per-operator "shown today" flip after dismiss.
- Next-day flips back to "should_show".
"""

from __future__ import annotations

import datetime as dt
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model

from apps.greetings.models import DailyGreetingShown, DailyQuote
from apps.greetings.selectors import should_show_greeting
from apps.greetings.services import (
    get_or_create_daily_quote,
    mark_greeting_shown,
)
from apps.operators.models import Operator
from apps.tg_userclient.ai.provider import QuoteResult
from apps.users.models import Profile, Role

User = get_user_model()


@pytest.fixture
def op(db):
    return Operator.objects.create(
        full_name="Стажёр Тестов", phone="+998901234567", status="active"
    )


@pytest.mark.django_db
def test_quote_generated_once_per_day_per_language():
    q1 = get_or_create_daily_quote(language="ru")
    q2 = get_or_create_daily_quote(language="ru")
    assert q1.pk is not None
    assert q1.pk == q2.pk
    assert DailyQuote.objects.filter(language="ru").count() == 1


@pytest.mark.django_db
def test_second_call_returns_cached_quote():
    q1 = get_or_create_daily_quote(language="ru")
    call_count = {"n": 0}

    from apps.greetings import services

    def fake_provider():
        call_count["n"] += 1

        class P:
            def generate_quote(self, *, prompt):
                return QuoteResult(text="freshly generated", author="Test", model_version="fake")

        return P()

    with patch.object(services, "get_llm_provider", fake_provider):
        q2 = get_or_create_daily_quote(language="ru")
    assert q2.pk == q1.pk
    # Provider must NOT be invoked because the cached row was returned.
    assert call_count["n"] == 0


@pytest.mark.django_db
def test_different_languages_get_separate_rows():
    ru = get_or_create_daily_quote(language="ru")
    uz = get_or_create_daily_quote(language="uz")
    assert ru.pk != uz.pk
    assert DailyQuote.objects.count() == 2


@pytest.mark.django_db
def test_llm_failure_returns_static_fallback_without_persisting():
    from apps.greetings import services

    class FailingProvider:
        def generate_quote(self, *, prompt):
            raise RuntimeError("boom")

    with patch.object(services, "get_llm_provider", lambda: FailingProvider()):
        quote = get_or_create_daily_quote(language="ru")

    assert "Успех" in quote.text  # static ru fallback text
    assert quote.pk is None  # NOT persisted → tomorrow retries LLM
    assert DailyQuote.objects.count() == 0


@pytest.mark.django_db
def test_should_show_flips_after_dismiss(op):
    assert should_show_greeting(operator=op) is True
    mark_greeting_shown(operator=op)
    assert should_show_greeting(operator=op) is False
    # Idempotent — calling mark twice does not error.
    mark_greeting_shown(operator=op)
    assert DailyGreetingShown.objects.filter(operator=op).count() == 1


@pytest.mark.django_db
def test_next_day_shows_again(op):
    mark_greeting_shown(operator=op)
    today = dt.date.today()
    tomorrow = today + dt.timedelta(days=1)
    # Rewrite the receipt to yesterday so today should_show returns True again.
    DailyGreetingShown.objects.filter(operator=op).update(date=today - dt.timedelta(days=1))
    assert should_show_greeting(operator=op, today=today) is True
    # And tomorrow (unrelated) also should show.
    assert should_show_greeting(operator=op, today=tomorrow) is True


@pytest.mark.django_db
def test_api_returns_should_show_and_dismiss_flips_it(client, op):
    from rest_framework.test import APIClient

    api = APIClient()
    user = User.objects.create_user(username="op-user", password="x")
    Profile.objects.create(user=user, role=Role.OPERATOR, operator=op)
    api.force_authenticate(user)

    r = api.get("/api/me/morning-greeting/")
    assert r.status_code == 200
    assert r.json()["should_show"] is True

    r = api.post("/api/me/morning-greeting/dismiss/")
    assert r.status_code == 200
    assert r.json()["marked"] is True

    r = api.get("/api/me/morning-greeting/")
    assert r.status_code == 200
    assert r.json()["should_show"] is False

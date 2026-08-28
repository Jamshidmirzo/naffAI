"""
Tests for the 3-hour leaderboard cron command (`send_3h_leaderboard`).

Covers:
  - render: sort order (unique_leads_touched DESC), top-10 cap, RU / UZ labels;
  - empty-state message when there's no operator activity today;
  - --dry-run doesn't invoke aiogram at all;
  - --min-hour / --max-hour guards skip send silently;
  - end-to-end (patched aiogram) — exactly N Bot.send_message calls.
"""
from __future__ import annotations

import datetime as dt
from io import StringIO
from unittest.mock import AsyncMock, patch

import pytest
from django.core.management import call_command
from django.utils import timezone

from apps.calls.models import CallAttempt, CallOutcome
from apps.leads.models import Lead, LeadStatus
from apps.operators.models import Operator, OperatorStatus
from apps.tg_bot.management.commands.send_3h_leaderboard import (
    _build_report,
    _sort_leaderboard,
)
from apps.tg_bot.models import BotSubscription


# --- fixtures ----------------------------------------------------------


@pytest.fixture(autouse=True)
def _stub_bot_token(settings):
    """Command bails out early if TELEGRAM_BOT_TOKEN is empty."""
    settings.TELEGRAM_BOT_TOKEN = "test-token-not-real"


@pytest.fixture
def _now_working_hour():
    """
    Force `timezone.localtime()` to return 13:00 today so --min/--max-hour
    guards don't trip in tests that don't care about them.
    """
    tz = timezone.get_current_timezone()
    today = timezone.localdate()
    frozen = dt.datetime.combine(today, dt.time(hour=13, minute=0), tzinfo=tz)
    with patch(
        "apps.tg_bot.management.commands.send_3h_leaderboard.timezone.localtime",
        return_value=frozen,
    ) as m:
        yield m


# --- pure render tests -------------------------------------------------


def test_sort_leaderboard_orders_by_unique_desc():
    rows = [
        {"operator_name": "A", "unique_leads_touched": 5, "sold_total": 1, "calls_total": 7},
        {"operator_name": "B", "unique_leads_touched": 10, "sold_total": 2, "calls_total": 12},
        {"operator_name": "C", "unique_leads_touched": 10, "sold_total": 5, "calls_total": 15},
    ]
    ordered = _sort_leaderboard(rows)
    # B and C tied on unique_leads=10 → C wins on sold_total tiebreak.
    assert [r["operator_name"] for r in ordered] == ["C", "B", "A"]


def test_build_report_ru_shape():
    snapshot = {
        "by_operator": [
            {"operator_name": "Bonu", "unique_leads_touched": 39, "sold_total": 12, "calls_total": 45},
            {"operator_name": "Umida", "unique_leads_touched": 31, "sold_total": 8, "calls_total": 34},
        ]
    }
    now = timezone.now()
    txt = _build_report(snapshot, now=now, lang="ru")
    assert "Оперативная сводка" in txt
    assert "Топ операторов" in txt
    assert "1. Bonu</b> — 39 обзвонил, 12 продажи" in txt
    assert "2. Umida</b> — 31 обзвонил, 8 продажи" in txt
    assert "Всего звонков" in txt
    assert "Всего продаж" in txt


def test_build_report_uz_shape():
    snapshot = {
        "by_operator": [
            {"operator_name": "Bonu", "unique_leads_touched": 3, "sold_total": 1, "calls_total": 4},
        ]
    }
    now = timezone.now()
    txt = _build_report(snapshot, now=now, lang="uz")
    assert "3 soatlik hisobot" in txt
    assert "Eng faol operatorlar" in txt
    assert "1. Bonu</b> — 3 obzvon, 1 sotuv" in txt
    assert "Jami qo'ng'iroqlar" in txt


def test_build_report_empty_state_ru():
    snapshot = {"by_operator": []}
    txt = _build_report(snapshot, now=timezone.now(), lang="ru")
    assert "Пока нет обзвонов" in txt


def test_build_report_empty_state_uz():
    snapshot = {"by_operator": []}
    txt = _build_report(snapshot, now=timezone.now(), lang="uz")
    assert "Hozircha faoliyat yo'q" in txt


def test_build_report_skips_zero_activity_rows():
    """
    Rows with `unique_leads_touched == 0` (e.g. dostik — sold but didn't
    call) must not pollute the leaderboard, though their sold_total still
    contributes to the aggregate `Всего продаж` line.
    """
    snapshot = {
        "by_operator": [
            {"operator_name": "Bonu", "unique_leads_touched": 5, "sold_total": 1, "calls_total": 6},
            {"operator_name": "Dostik", "unique_leads_touched": 0, "sold_total": 10, "calls_total": 0},
        ]
    }
    txt = _build_report(snapshot, now=timezone.now(), lang="ru")
    assert "Bonu" in txt
    assert "Dostik" not in txt
    # But total sold accumulates over ALL rows (1 + 10 = 11).
    assert "Всего продаж</b>: <b>11" in txt or "Всего продаж: <b>11</b>" in txt


def test_build_report_top_n_cap():
    snapshot = {
        "by_operator": [
            {"operator_name": f"Op{i}", "unique_leads_touched": 100 - i, "sold_total": 0, "calls_total": 100 - i}
            for i in range(15)
        ]
    }
    txt = _build_report(snapshot, now=timezone.now(), lang="ru", top_n=10)
    assert "10. Op9" in txt
    assert "11. Op10" not in txt


# --- command-level tests -----------------------------------------------


@pytest.mark.django_db
def test_dry_run_does_not_call_aiogram(_now_working_hour):
    """--dry-run must never touch the Bot HTTP client."""
    BotSubscription.objects.create(chat_id=1001, is_active=True, language="ru")
    BotSubscription.objects.create(chat_id=1002, is_active=True, language="uz")

    out = StringIO()
    with patch(
        "apps.tg_bot.management.commands.send_3h_leaderboard._send_dm",
        new_callable=AsyncMock,
    ) as send_mock:
        call_command("send_3h_leaderboard", "--dry-run", stdout=out)
        assert send_mock.await_count == 0
        assert send_mock.call_count == 0

    stdout = out.getvalue()
    assert "dry-run" in stdout
    assert "would send to 2 chats" in stdout


@pytest.mark.django_db
def test_hour_guard_below_min_skips(_now_working_hour):
    """--min-hour above current local hour → early return, no send attempts."""
    BotSubscription.objects.create(chat_id=2001, is_active=True, language="ru")

    out = StringIO()
    with patch(
        "apps.tg_bot.management.commands.send_3h_leaderboard._send_dm",
        new_callable=AsyncMock,
    ) as send_mock:
        # frozen now=13:00 → --min-hour=15 skips.
        call_command("send_3h_leaderboard", "--min-hour=15", stdout=out)
        assert send_mock.await_count == 0

    assert "skip" in out.getvalue()


@pytest.mark.django_db
def test_hour_guard_above_max_skips(_now_working_hour):
    BotSubscription.objects.create(chat_id=2002, is_active=True, language="ru")

    out = StringIO()
    with patch(
        "apps.tg_bot.management.commands.send_3h_leaderboard._send_dm",
        new_callable=AsyncMock,
    ) as send_mock:
        # frozen now=13:00 → --max-hour=10 skips.
        call_command("send_3h_leaderboard", "--max-hour=10", stdout=out)
        assert send_mock.await_count == 0

    assert "skip" in out.getvalue()


@pytest.mark.django_db
def test_live_send_hits_every_active_sub(_now_working_hour):
    """
    2 active + 1 inactive + 1 blocked subs → exactly 2 aiogram send_dm calls.
    """
    BotSubscription.objects.create(chat_id=3001, is_active=True, language="ru")
    BotSubscription.objects.create(chat_id=3002, is_active=True, language="uz")
    BotSubscription.objects.create(chat_id=3003, is_active=False, language="ru")
    BotSubscription.objects.create(
        chat_id=3004,
        is_active=True,
        language="ru",
        blocked_at=timezone.now(),
    )

    out = StringIO()
    send_mock = AsyncMock(return_value=(True, ""))
    with patch(
        "apps.tg_bot.management.commands.send_3h_leaderboard._send_dm",
        new=send_mock,
    ):
        call_command("send_3h_leaderboard", stdout=out)

    assert send_mock.await_count == 2
    sent_chat_ids = {call.args[0] for call in send_mock.await_args_list}
    assert sent_chat_ids == {3001, 3002}
    assert "delivered 2/2" in out.getvalue()


@pytest.mark.django_db
def test_live_send_end_to_end_with_real_activity(_now_working_hour):
    """
    Full happy path: 2 operators with actual CallAttempts today → snapshot
    picks them up → sub receives a leaderboard mentioning both.
    """
    op1 = Operator.objects.create(full_name="Bonu", status=OperatorStatus.ACTIVE)
    op2 = Operator.objects.create(full_name="Umida", status=OperatorStatus.ACTIVE)
    lead1 = Lead.objects.create(full_name="L1", status=LeadStatus.NEW)
    lead2 = Lead.objects.create(full_name="L2", status=LeadStatus.NEW)
    CallAttempt.objects.create(lead=lead1, operator=op1, outcome=CallOutcome.NO_ANSWER)
    CallAttempt.objects.create(lead=lead2, operator=op1, outcome=CallOutcome.NO_ANSWER)
    CallAttempt.objects.create(lead=lead1, operator=op2, outcome=CallOutcome.NO_ANSWER)

    BotSubscription.objects.create(chat_id=4001, is_active=True, language="ru")

    out = StringIO()
    send_mock = AsyncMock(return_value=(True, ""))
    with patch(
        "apps.tg_bot.management.commands.send_3h_leaderboard._send_dm",
        new=send_mock,
    ):
        call_command("send_3h_leaderboard", stdout=out)

    assert send_mock.await_count == 1
    sent_text = send_mock.await_args_list[0].args[1]
    # Bonu did 2 leads, Umida 1 → Bonu ranked #1.
    assert "1. Bonu</b> — 2 обзвонил" in sent_text
    assert "2. Umida</b> — 1 обзвонил" in sent_text

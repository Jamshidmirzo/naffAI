"""
Bot v2 tests: report block rendering, scheduler idempotency, RBAC
sensitivity filtering.
"""

from __future__ import annotations

import datetime as dt
from decimal import Decimal

import pytest
from django.utils import timezone

from apps.catalog.models import Channel
from apps.operators.models import Operator
from apps.sales.services import sale_create
from apps.tg_bot.models import BotChat, BotReport
from apps.tg_bot.renderer import render_report
from apps.tg_bot.report_blocks import BLOCKS, blocks_for_chat_kind
from apps.tg_bot.scheduler import report_should_fire


@pytest.fixture
def operator(db):
    return Operator.objects.create(full_name="Мадина Иванова", status="active")


@pytest.fixture
def channel(db):
    return Channel.objects.create(name="Наличные")


@pytest.fixture
def a_sale(db, operator, channel):
    return sale_create(
        imei="490154203237518",
        phone_model="iPhone 17",
        operator_id=operator.id,
        channel_id=channel.id,
        amount=Decimal("5000000"),
    )


@pytest.mark.django_db
def test_render_sales_total_block(a_sale):
    now = timezone.localtime()
    start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    end = start + dt.timedelta(days=1)
    out = BLOCKS["sales_total"].render(start, end, "ru")
    assert "Продажи" in out
    assert "5" in out  # 5M amount


@pytest.mark.django_db
def test_render_top_operators_block(a_sale):
    now = timezone.localtime()
    start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    end = start + dt.timedelta(days=1)
    out = BLOCKS["top_operators"].render(start, end, "uz")
    assert "Мадина" in out or "🥇" in out


@pytest.mark.django_db
def test_blocks_for_chat_kind_strips_sensitive_in_group():
    chosen = ["sales_total", "pending_sales", "top_operators", "leads_stats"]
    private = blocks_for_chat_kind(chosen, "private")
    group = blocks_for_chat_kind(chosen, "group")
    private_slugs = [b.slug for b in private]
    group_slugs = [b.slug for b in group]
    assert set(private_slugs) == set(chosen)
    assert "pending_sales" not in group_slugs  # sensitive → stripped
    assert "leads_stats" not in group_slugs  # sensitive → stripped
    assert "sales_total" in group_slugs  # non-sensitive → kept
    assert "top_operators" in group_slugs


@pytest.mark.django_db
def test_render_report_produces_html_with_header(a_sale):
    chat = BotChat.objects.create(chat_id=-100, kind="group", title="Test group")
    report = BotReport.objects.create(
        name="Kunlik hisobot",
        schedule_time=dt.time(20, 0),
        schedule_days=[],
        blocks=["sales_total", "top_operators"],
        language="uz",
        period="today",
        include_header=True,
    )
    text = render_report(report, chat)
    assert "<b>Kunlik hisobot</b>" in text
    assert "Bugun" in text
    assert "───" in text
    assert "5" in text  # amount


@pytest.mark.django_db
def test_render_report_strips_manager_blocks_for_group(a_sale):
    # chat.language overrides report.language per-recipient, so set the
    # chat itself to ru to make assertions readable.
    chat = BotChat.objects.create(chat_id=-100, kind="group", title="Ops group", language="ru")
    report = BotReport.objects.create(
        name="Test",
        schedule_time=dt.time(9, 0),
        blocks=["sales_total", "pending_sales", "payroll_progress"],
        language="ru",
        period="today",
    )
    text = render_report(report, chat)
    assert "Продажи" in text
    # Sensitive blocks must be stripped from group message.
    assert "payroll" not in text.lower()
    assert "Ждут подтверждения" not in text


@pytest.mark.django_db
def test_scheduler_idempotency_same_day():
    """Report already sent today (last_sent_at is today) → should not fire again."""
    now = timezone.localtime()
    report = BotReport.objects.create(
        name="X",
        schedule_time=dt.time(0, 0),  # in the past today
        schedule_days=[],
        blocks=["sales_total"],
        last_sent_at=now,  # already fired
    )
    assert not report_should_fire(report, now)


@pytest.mark.django_db
def test_scheduler_should_fire_when_time_passed():
    now = timezone.localtime()
    schedule = (now - dt.timedelta(minutes=5)).time()
    report = BotReport.objects.create(
        name="X",
        schedule_time=schedule,
        schedule_days=[],  # every day
        blocks=["sales_total"],
        last_sent_at=None,
    )
    assert report_should_fire(report, now)


@pytest.mark.django_db
def test_scheduler_skips_wrong_weekday():
    now = timezone.localtime()
    weekday_keys = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
    today = weekday_keys[now.weekday()]
    other_days = [d for d in weekday_keys if d != today]
    report = BotReport.objects.create(
        name="X",
        schedule_time=(now - dt.timedelta(minutes=5)).time(),
        schedule_days=other_days,
        blocks=["sales_total"],
    )
    assert not report_should_fire(report, now)


@pytest.mark.django_db
def test_scheduler_disabled_never_fires():
    now = timezone.localtime()
    report = BotReport.objects.create(
        name="X",
        enabled=False,
        schedule_time=(now - dt.timedelta(minutes=5)).time(),
        blocks=["sales_total"],
    )
    assert not report_should_fire(report, now)

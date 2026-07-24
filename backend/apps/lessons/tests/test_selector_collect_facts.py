import datetime as dt
from decimal import Decimal
import pytest
from django.utils import timezone

from apps.operators.models import Operator, OperatorMonthlyPlan
from apps.sales.models import Sale, SaleOperator
from apps.catalog.models import Channel
from apps.tg_userclient.models import TgSession, TgChat, TgMessage, TgAiInsight
from apps.calls.models import CallbackReminder, CallbackReminderStatus
from apps.leads.models import Lead, LeadStatus
from apps.lessons.selectors import collect_yesterday_facts


@pytest.fixture
def operator(db):
    return Operator.objects.create(full_name="Тестовый Продавец", status="active")


@pytest.fixture
def channel(db):
    return Channel.objects.create(name="Cash", is_active=True)


@pytest.mark.django_db
def test_collect_facts_empty_day(operator):
    today = timezone.localdate()
    yesterday = today - dt.timedelta(days=1)

    facts = collect_yesterday_facts(operator, yesterday)
    assert facts["sales"]["count"] == 0
    assert facts["sales"]["revenue"] == 0.0
    assert facts["dialogs"]["count"] == 0
    assert facts["callbacks"]["missed"] == 0
    assert facts["leads"]["won"] == 0
    assert len(facts["chat_examples"]) == 0


@pytest.mark.django_db
def test_collect_facts_active_day(operator, channel):
    today = timezone.localdate()
    yesterday = today - dt.timedelta(days=1)
    tz = timezone.get_current_timezone()

    # Yesterday's sale
    sale = Sale.objects.create(
        imei="123456789012345",
        phone_model="iPhone 15 Pro",
        operator=operator,
        channel=channel,
        amount=Decimal("15000000.00"),
        sold_at=dt.datetime.combine(yesterday, dt.time(12, 0), tzinfo=tz),
        status="confirmed",
    )
    SaleOperator.objects.create(sale=sale, operator=operator, amount=Decimal("15000000.00"))

    # Monthly plan
    OperatorMonthlyPlan.objects.create(
        operator=operator,
        year=yesterday.year,
        month=yesterday.month,
        target_amount=Decimal("100000000.00"),
    )

    # Yesterday's TG dialogs
    session = TgSession.objects.create(operator=operator, phone="+998901234567", status="active")
    chat = TgChat.objects.create(session=session, tg_chat_id=111, kind="private", title="Клиент 1")
    TgMessage.objects.create(
        chat=chat,
        tg_message_id=1,
        direction="in",
        kind="text",
        text="Привет, есть айфон?",
        sent_at=dt.datetime.combine(yesterday, dt.time(10, 0), tzinfo=tz),
    )
    TgMessage.objects.create(
        chat=chat,
        tg_message_id=2,
        direction="out",
        kind="text",
        text="Да, конечно, iPhone 15 Pro в наличии",
        sent_at=dt.datetime.combine(yesterday, dt.time(10, 5), tzinfo=tz),
    )

    TgAiInsight.objects.create(
        session=session,
        chat=chat,
        since=dt.datetime.combine(yesterday, dt.time(9, 0), tzinfo=tz),
        until=dt.datetime.combine(yesterday, dt.time(18, 0), tzinfo=tz),
        model_version="test",
        prompt_version="v1",
        summary="Хороший диалог",
        quality_score=90,
        red_flags=["нет предложения рассрочки"],
        highlights=["быстрый ответ"],
    )

    # Callback reminder
    lead = Lead.objects.create(
        full_name="Покупатель",
        phone="+998909876543",
        status=LeadStatus.WON,
        operator=operator,
    )
    Lead.objects.filter(pk=lead.pk).update(
        updated_at=dt.datetime.combine(yesterday, dt.time(15, 0), tzinfo=tz)
    )
    CallbackReminder.objects.create(
        lead=lead,
        operator=operator,
        remind_at=dt.datetime.combine(yesterday, dt.time(11, 0), tzinfo=tz),
        status=CallbackReminderStatus.OVERDUE,
    )

    # Collect facts
    facts = collect_yesterday_facts(operator, yesterday)

    assert facts["sales"]["count"] == 1
    assert facts["sales"]["revenue"] == 15000000.0
    assert facts["sales"]["brand_mix"] == {"iPhone 15 Pro": 1}
    assert facts["dialogs"]["count"] == 1
    assert facts["dialogs"]["avg_quality_score"] == 90.0
    assert facts["dialogs"]["top_3_red_flags"] == ["нет предложения рассрочки"]
    assert facts["callbacks"]["missed"] == 1
    assert facts["leads"]["won"] == 1
    assert len(facts["chat_examples"]) == 1
    assert facts["chat_examples"][0]["chat"] == "Клиент 1"
    assert "Привет, есть айфон?" in facts["chat_examples"][0]["excerpt"]
    assert facts["chat_examples"][0]["issue"] == "нет предложения рассрочки"
    assert facts["context"]["month_progress_pct"] == 15.0

import pytest
from django.utils import timezone
from apps.tg_bot.models import BotSubscription
from apps.tg_bot.selectors import subscriptions_ready_for_dm


@pytest.mark.django_db
def test_daily_report_subscription_filtered_when_already_sent_today():
    today = timezone.localdate()
    sub1 = BotSubscription.objects.create(chat_id=101, is_active=True, last_daily_report_date=today)
    sub2 = BotSubscription.objects.create(chat_id=102, is_active=True, last_daily_report_date=None)

    ready = subscriptions_ready_for_dm().exclude(last_daily_report_date=today)
    chat_ids = list(ready.values_list("chat_id", flat=True))

    assert sub1.chat_id not in chat_ids
    assert sub2.chat_id in chat_ids


@pytest.mark.django_db
def test_daily_report_subscription_included_next_day():
    today = timezone.localdate()
    yesterday = today - timezone.timedelta(days=1)
    sub = BotSubscription.objects.create(chat_id=103, is_active=True, last_daily_report_date=yesterday)

    ready = subscriptions_ready_for_dm().exclude(last_daily_report_date=today)
    chat_ids = list(ready.values_list("chat_id", flat=True))

    assert sub.chat_id in chat_ids

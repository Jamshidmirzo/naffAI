"""
Selector unit tests for `bot_broadcast_recipients()`.

Guards against regressions where the cron accidentally reverts to
"all active subs" or forgets to skip blocked chats.
"""

from __future__ import annotations

import pytest
from django.utils import timezone

from apps.tg_bot.models import BotSubscription
from apps.tg_bot.selectors import bot_broadcast_recipients


@pytest.mark.django_db
def test_only_active_broadcasts_true_pass():
    good = BotSubscription.objects.create(
        chat_id=10, is_active=True, receives_broadcasts=True
    )
    BotSubscription.objects.create(
        chat_id=11, is_active=True, receives_broadcasts=False
    )
    BotSubscription.objects.create(
        chat_id=12, is_active=False, receives_broadcasts=True
    )
    BotSubscription.objects.create(
        chat_id=13,
        is_active=True,
        receives_broadcasts=True,
        blocked_at=timezone.now(),
    )

    qs = list(bot_broadcast_recipients())
    assert qs == [good]


@pytest.mark.django_db
def test_empty_when_no_active_broadcasts():
    BotSubscription.objects.create(
        chat_id=20, is_active=True, receives_broadcasts=False
    )
    assert list(bot_broadcast_recipients()) == []
